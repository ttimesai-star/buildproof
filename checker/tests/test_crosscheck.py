"""Run: python -m pytest checker/tests  (or: python checker/tests/test_crosscheck.py)"""
import glob
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "checker"))
import crosscheck  # noqa: E402

PDFS = sorted(glob.glob(os.path.join(ROOT, "examples", "pdf", "*.pdf")))


def _codes(report, doc):
    return sorted(x["code"] for x in report["findings"] if x["document"] == doc)


def test_planted_discrepancies_found_and_nothing_else():
    r = crosscheck.run(PDFS)
    assert _codes(r, "act_01.pdf") == []
    assert _codes(r, "contract_GC-2026-014.pdf") == []
    assert _codes(r, "supplementary_agreement_01.pdf") == []
    assert _codes(r, "act_02.pdf") == ["LINE_ARITHMETIC", "RATE"]
    assert _codes(r, "act_03.pdf") == ["CONTRACT_REF", "PARTY_IBAN", "QUANTITY_OVERRUN", "VAT"]
    assert r["summary"] == {"errors": 6, "warnings": 0}


def test_clean_subset_passes():
    clean = [p for p in PDFS if os.path.basename(p) in
             ("contract_GC-2026-014.pdf", "supplementary_agreement_01.pdf", "act_01.pdf")]
    r = crosscheck.run(clean)
    assert r["findings"] == []


def test_supplementary_agreement_rate_applies_from_effective_date():
    r = crosscheck.run(PDFS)
    rate = [x for x in r["findings"] if x["code"] == "RATE"][0]
    assert rate["expected"] == 27.5 and rate["found"] == 29.0
    assert "2026-06-01" in rate["message"]


def test_report_hash_is_stable():
    assert crosscheck.run(PDFS)["report_sha256"] == crosscheck.run(PDFS)["report_sha256"]


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("PASS", name)
