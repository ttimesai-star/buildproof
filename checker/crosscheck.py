"""BuildProof cross-check: compare fields across a contract, its supplementary agreements
and acceptance acts, and flag discrepancies before anyone signs.

Design rule: the language model (optional) only EXTRACTS fields from document text.
All arithmetic and every rule below is deterministic Python, so a finding can always be
traced to two numbers on two pages. Without --llm a strict regex extractor is used.

  python checker/crosscheck.py examples/pdf/*.pdf
  python checker/crosscheck.py examples/pdf/*.pdf --llm --json report.json

LLM settings (any OpenAI-compatible endpoint):
  BP_LLM_BASE_URL  e.g. https://api.groq.com/openai/v1
  BP_LLM_API_KEY
  BP_LLM_MODEL
"""
import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import date

EPS = 0.005


# ---------------------------------------------------------------- extraction

def pdf_text(path):
    from pypdf import PdfReader
    return "\n".join((p.extract_text() or "") for p in PdfReader(path).pages)


def _num(s):
    s = str(s).strip().replace(" ", "").replace("\xa0", "")
    if "." in s and "," in s:
        if s.rfind(",") > s.rfind("."):
            s = s.replace(".", "").replace(",", ".")
        else:
            s = s.replace(",", "")
    elif "," in s:
        parts = s.split(",")
        if len(parts) > 2:
            s = s.replace(",", "")
        else:
            s = s.replace(",", ".")
    return float(s)


def _party(text, label):
    m = re.search(r"^%s:\s*(.+?)\s*\|\s*Tax ID:\s*(\S+)\s*\|\s*IBAN:\s*(.+?)\s*$" % label, text, re.M)
    return {"name": m.group(1), "tax_id": m.group(2), "iban": m.group(3)} if m else None


def parse_regex(text):
    g = lambda pat: (re.search(pat, text, re.M) or [None, None])[1]
    kind = g(r"^Document type:\s*(.+?)\s*$")
    d = {
        "kind": kind,
        "title": text.splitlines()[1].strip() if len(text.splitlines()) > 1 else None,
        "number": g(r"^Document No\.:\s*(\S+)") if kind != "Contract" else g(r"^Contract No\.:\s*(\S+)"),
        "contract_ref": g(r"^Contract No\.:\s*(\S+)"),
        "date": g(r"^Date:\s*(\d{4}-\d{2}-\d{2})"),
        "term": None, "period": None,
        "client": _party(text, "Client"),
        "contractor": _party(text, "Contractor"),
        "lines": [], "changes": [],
        "subtotal": None, "vat_rate": None, "vat": None, "total": None,
    }
    for key in ("term", "period"):
        m = re.search(r"^%s:\s*(\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})" % key.capitalize(), text, re.M)
        if m:
            d[key] = [m.group(1), m.group(2)]
    for m in re.finditer(r"^(\d+)\s+(.+?)\s+(m3|m2|pcs|t|m)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)\s*$", text, re.M):
        d["lines"].append({"item": int(m.group(1)), "name": m.group(2).strip(), "unit": m.group(3),
                           "qty": _num(m.group(4)), "rate": _num(m.group(5)), "amount": _num(m.group(6))})
    for m in re.finditer(r"^Change: item (\d+) (quantity|rate) ([\d.,]+) -> ([\d.,]+) effective (\d{4}-\d{2}-\d{2})",
                         text, re.M):
        d["changes"].append({"item": int(m.group(1)), "field": m.group(2), "from": _num(m.group(3)),
                             "to": _num(m.group(4)), "effective": m.group(5)})
    prefix = "New contract " if kind == "Supplementary Agreement" else ""
    for key, pat in (("subtotal", r"subtotal:\s*([\d.,]+)"), ("total", r"total:\s*([\d.,]+)")):
        m = re.search(r"^%s%s" % (prefix, pat), text, re.M | re.I)
        if m:
            d[key] = _num(m.group(1))
    m = re.search(r"^New contract VAT:\s*([\d.,]+)", text, re.M) if prefix else \
        re.search(r"^VAT (\d+(?:\.\d+)?)%:\s*([\d.,]+)", text, re.M)
    if m and prefix:
        d["vat"] = _num(m.group(1))
    elif m:
        d["vat_rate"], d["vat"] = float(m.group(1)), _num(m.group(2))
    return d


LLM_PROMPT = """Extract fields from this construction document. Reply with JSON only, no prose.
Schema: {"kind": "Contract"|"Supplementary Agreement"|"Acceptance Act"|"Invoice"|"Other",
"title": str, "number": str, "contract_ref": str|null, "date": "YYYY-MM-DD",
"term": [start,end]|null, "period": [start,end]|null,
"client": {"name","tax_id","iban"}|null, "contractor": {"name","tax_id","iban"}|null,
"lines": [{"item": int, "name": str, "unit": str, "qty": number, "rate": number, "amount": number}],
"changes": [{"item": int, "field": "quantity"|"rate", "from": number, "to": number, "effective": "YYYY-MM-DD"}],
"subtotal": number|null, "vat_rate": number|null, "vat": number|null, "total": number|null}
For a supplementary agreement put the NEW contract subtotal/VAT/total in subtotal/vat/total.
Copy numbers exactly as printed. Do not compute or correct anything. Unknown -> null.

DOCUMENT:
"""


def parse_llm(text):
    base = os.environ.get("BP_LLM_BASE_URL")
    key = os.environ.get("BP_LLM_API_KEY")
    model = os.environ.get("BP_LLM_MODEL")
    if not (base and key and model):
        raise SystemExit("--llm needs BP_LLM_BASE_URL, BP_LLM_API_KEY and BP_LLM_MODEL")
    body = {"model": model, "temperature": 0,
            "messages": [{"role": "user", "content": LLM_PROMPT + text}]}
    req = urllib.request.Request(base.rstrip("/") + "/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Authorization": "Bearer " + key, "Content-Type": "application/json",
                                          "User-Agent": "buildproof-checker/0.1"})
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                content = json.load(r)["choices"][0]["message"]["content"]
            break
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503) or attempt == 5:
                raise
            time.sleep(2 ** attempt)
    m = re.search(r"\{.*\}", content, re.S)
    return json.loads(m.group(0))


def compare_extractions(a, b):
    """Fields where the regex and the LLM disagree (a disagreement is itself a finding)."""
    diffs = []
    for k in ("kind", "number", "contract_ref", "date", "subtotal", "vat", "total"):
        if k == "contract_ref" and a.get("kind") == "Contract":
            continue  # a contract does not refer to itself
        x, y = a.get(k), b.get(k)
        if isinstance(x, float) or isinstance(y, float):
            if x is None or y is None or abs(float(x) - float(y)) > EPS:
                diffs.append((k, x, y))
        elif str(x or "").strip() != str(y or "").strip():
            diffs.append((k, x, y))
    if len(a.get("lines") or []) != len(b.get("lines") or []):
        diffs.append(("lines.count", len(a.get("lines") or []), len(b.get("lines") or [])))
    return diffs


# ---------------------------------------------------------------- rules

class Findings:
    def __init__(self):
        self.items = []

    def add(self, sev, doc, code, msg, expected=None, found=None):
        self.items.append({"severity": sev, "document": doc, "code": code, "message": msg,
                           "expected": expected, "found": found})


def _d(s):
    return date.fromisoformat(s) if s else None


def check_arithmetic(name, d, f):
    lines = d.get("lines") or []
    for ln in lines:
        calc = round(ln["qty"] * ln["rate"], 2)
        if abs(calc - ln["amount"]) > EPS:
            f.add("error", name, "LINE_ARITHMETIC",
                  "item %d: %.3f x %.2f = %.2f, document says %.2f" % (ln["item"], ln["qty"], ln["rate"], calc,
                                                                     ln["amount"]), calc, ln["amount"])
    if lines and d.get("subtotal") is not None:
        s = round(sum(ln["amount"] for ln in lines), 2)
        if abs(s - d["subtotal"]) > EPS:
            f.add("error", name, "SUBTOTAL", "sum of lines %.2f, subtotal says %.2f" % (s, d["subtotal"]),
                  s, d["subtotal"])
    if d.get("vat_rate") is not None and d.get("subtotal") is not None and d.get("vat") is not None:
        v = round(d["subtotal"] * d["vat_rate"] / 100.0, 2)
        if abs(v - d["vat"]) > EPS:
            f.add("error", name, "VAT", "VAT %g%% of %.2f is %.2f, document says %.2f"
                  % (d["vat_rate"], d["subtotal"], v, d["vat"]), v, d["vat"])
    if None not in (d.get("subtotal"), d.get("vat"), d.get("total")):
        t = round(d["subtotal"] + d["vat"], 2)
        if abs(t - d["total"]) > EPS:
            f.add("error", name, "TOTAL", "subtotal + VAT = %.2f, total says %.2f" % (t, d["total"]), t, d["total"])


def contract_state(contract, sas, on_date):
    """Contract lines with every supplementary-agreement change effective on `on_date`."""
    items = {ln["item"]: dict(ln) for ln in contract["lines"]}
    for name, sa in sas:
        if _d(sa["date"]) > on_date:
            continue
        for ch in sa["changes"]:
            if ch["item"] in items and _d(ch["effective"]) <= on_date:
                items[ch["item"]]["qty" if ch["field"] == "quantity" else "rate"] = ch["to"]
    for it in items.values():
        it["amount"] = round(it["qty"] * it["rate"], 2)
    return items


def check_set(docs):
    """docs: list of (name, fields). Returns Findings."""
    f = Findings()
    contracts = [(n, d) for n, d in docs if d.get("kind") == "Contract"]
    sas = sorted([(n, d) for n, d in docs if d.get("kind") == "Supplementary Agreement"], key=lambda x: x[1]["date"])
    acts = sorted([(n, d) for n, d in docs if d.get("kind") == "Acceptance Act"], key=lambda x: x[1]["date"])

    for n, d in docs:
        for k in ("kind", "date"):
            if not d.get(k):
                f.add("error", n, "MISSING_FIELD", "could not read field '%s'" % k)
        check_arithmetic(n, d, f)

    if len(contracts) != 1:
        f.add("error", "(set)", "CONTRACT_COUNT", "expected exactly one contract, found %d" % len(contracts))
        return f
    cname, contract = contracts[0]
    c_date = _d(contract["date"])
    term = [_d(x) for x in contract["term"]] if contract.get("term") else None

    for n, d in sas + acts:
        if d.get("contract_ref") != contract["number"]:
            f.add("error", n, "CONTRACT_REF", "refers to contract %s, the contract is %s"
                  % (d.get("contract_ref"), contract["number"]), contract["number"], d.get("contract_ref"))
        for role in ("client", "contractor"):
            a, b = contract.get(role) or {}, d.get(role) or {}
            for k in ("name", "tax_id", "iban"):
                if a.get(k) != b.get(k):
                    f.add("error", n, "PARTY_" + k.upper(), "%s %s differs from the contract"
                          % (role, k.replace("_", " ")), a.get(k), b.get(k))
        if _d(d["date"]) < c_date:
            f.add("error", n, "DATE_BEFORE_CONTRACT", "dated %s, before the contract (%s)" % (d["date"], contract["date"]))

    for n, sa in sas:
        new = contract_state(contract, [(n, sa)] + [s for s in sas if s[1]["date"] < sa["date"]], date.max)
        sub = round(sum(it["amount"] for it in new.values()), 2)
        if sa.get("subtotal") is not None and abs(sub - sa["subtotal"]) > EPS:
            f.add("error", n, "SA_NEW_PRICE", "amended items add up to %.2f, agreement says %.2f"
                  % (sub, sa["subtotal"]), sub, sa["subtotal"])
        for ch in sa["changes"]:
            if ch["item"] not in new:
                f.add("error", n, "SA_UNKNOWN_ITEM", "changes item %d that is not in the contract" % ch["item"])
                continue
            base = contract_state(contract, [s for s in sas if s[1]["date"] < sa["date"]], date.max)[ch["item"]]
            was = base["qty" if ch["field"] == "quantity" else "rate"]
            if abs(was - ch["from"]) > EPS:
                f.add("error", n, "SA_FROM_VALUE", "item %d %s was %g, agreement says it was %g"
                      % (ch["item"], ch["field"], was, ch["from"]), was, ch["from"])

    cumulative = {}
    for n, act in acts:
        p0, p1 = [_d(x) for x in act["period"]] if act.get("period") else (_d(act["date"]), _d(act["date"]))
        if term and (p0 < term[0] or p1 > term[1]):
            f.add("warning", n, "PERIOD_OUTSIDE_TERM", "period %s..%s outside contract term %s..%s"
                  % (p0, p1, term[0], term[1]))
        if p1 > _d(act["date"]):
            f.add("error", n, "PERIOD_AFTER_ACT_DATE", "period ends %s, after the act date %s" % (p1, act["date"]))
        at_start = contract_state(contract, sas, p0)
        at_end = contract_state(contract, sas, p1)
        at_act = contract_state(contract, sas, _d(act["date"]))
        for ln in act.get("lines") or []:
            it = ln["item"]
            if it not in at_act:
                f.add("error", n, "UNKNOWN_ITEM", "item %d is not in the contract" % it)
                continue
            if ln["unit"] != at_act[it]["unit"]:
                f.add("error", n, "UNIT", "item %d unit %s, contract unit %s" % (it, ln["unit"], at_act[it]["unit"]),
                      at_act[it]["unit"], ln["unit"])
            allowed = {at_start[it]["rate"], at_end[it]["rate"]}
            if not any(abs(ln["rate"] - r) <= EPS for r in allowed):
                later = [ch for _, sa in sas for ch in sa["changes"]
                         if ch["item"] == it and ch["field"] == "rate" and abs(ch["to"] - ln["rate"]) <= EPS]
                hint = (" (rate %.2f takes effect only on %s)" % (ln["rate"], later[0]["effective"])) if later else ""
                f.add("error", n, "RATE", "item %d rate %.2f, contract rate for %s..%s is %.2f%s"
                      % (it, ln["rate"], p0, p1, at_end[it]["rate"], hint), at_end[it]["rate"], ln["rate"])
            elif len(allowed) > 1:
                f.add("warning", n, "RATE_CHANGES_IN_PERIOD", "item %d rate changes inside the period; check the split" % it)
            cumulative[it] = round(cumulative.get(it, 0) + ln["qty"], 3)
            if cumulative[it] - at_act[it]["qty"] > EPS:
                f.add("error", n, "QUANTITY_OVERRUN", "item %d cumulative %.3f %s exceeds contract %.3f %s"
                      % (it, cumulative[it], ln["unit"], at_act[it]["qty"], ln["unit"]), at_act[it]["qty"], cumulative[it])

    if acts:
        last = acts[-1][1]
        cap = round(sum(it["amount"] for it in contract_state(contract, sas, _d(last["date"])).values()), 2)
        done = round(sum(a.get("subtotal") or 0 for _, a in acts), 2)
        if done - cap > EPS:
            f.add("error", "(set)", "PRICE_OVERRUN", "acts total %.2f exceeds contract price %.2f (net of VAT)"
                  % (done, cap), cap, done)
    return f


# ---------------------------------------------------------------- cli

def run(paths, use_llm=False, llm_only=False):
    docs, extraction = [], []
    for p in paths:
        text = pdf_text(p)
        rx = parse_regex(text)
        used, note = rx, "regex"
        if use_llm:
            llm = parse_llm(text)
            diffs = compare_extractions(rx, llm)
            extraction.append({"document": os.path.basename(p), "llm_vs_regex": diffs})
            if llm_only or not rx.get("kind") or not (rx.get("lines") or rx.get("changes")):
                used, note = llm, "llm"
        docs.append((os.path.basename(p), used))
        extraction.append({"document": os.path.basename(p), "extractor": note})
    f = check_set(docs)
    if use_llm:
        for e in extraction:
            for k, a, b in e.get("llm_vs_regex", []):
                f.add("warning", e["document"], "EXTRACTION_DISAGREES", "field %s: regex %r, LLM %r" % (k, a, b))
    report = {
        "tool": "buildproof-crosscheck/0.1",
        "documents": [{"file": n, "sha256": sha256_file(p), "kind": d.get("kind"), "number": d.get("number")}
                      for (n, d), p in zip(docs, paths)],
        "findings": f.items,
        "summary": {"errors": sum(1 for x in f.items if x["severity"] == "error"),
                    "warnings": sum(1 for x in f.items if x["severity"] == "warning")},
    }
    canon = json.dumps(report, sort_keys=True, separators=(",", ":")).encode()
    report["report_sha256"] = "0x" + hashlib.sha256(canon).hexdigest()
    return report


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 16), b""):
            h.update(chunk)
    return "0x" + h.hexdigest()


def print_report(r):
    for d in r["documents"]:
        mine = [x for x in r["findings"] if x["document"] == d["file"]]
        mark = "OK " if not any(x["severity"] == "error" for x in mine) else "!! "
        print("%s%-34s %-24s %s" % (mark, d["file"], d["kind"], d["sha256"][:18] + "..."))
        for x in mine:
            print("     [%s] %s: %s" % (x["severity"], x["code"], x["message"]))
    for x in [x for x in r["findings"] if x["document"] == "(set)"]:
        print("!! (whole set) [%s] %s: %s" % (x["severity"], x["code"], x["message"]))
    s = r["summary"]
    print("\n%d error(s), %d warning(s). Report hash %s" % (s["errors"], s["warnings"], r["report_sha256"]))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("pdf", nargs="+")
    ap.add_argument("--llm", action="store_true", help="also extract with an LLM and compare")
    ap.add_argument("--llm-only", action="store_true",
                    help="run the rules on LLM-extracted fields (for documents without a known layout)")
    ap.add_argument("--json", help="write the full report here")
    a = ap.parse_args(argv)
    r = run(a.pdf, a.llm or a.llm_only, a.llm_only)
    print_report(r)
    if a.json:
        with open(a.json, "w", encoding="utf-8") as fh:
            json.dump(r, fh, indent=2)
    return 1 if r["summary"]["errors"] else 0


if __name__ == "__main__":
    sys.exit(main())
