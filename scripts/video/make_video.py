# BuildProof demo video v2: narrated (edge-tts synthetic voice), live verify page on Base mainnet, captions.
# Output: scripts/video/out/buildproof_demo_v2.mp4 (1280x800). No face, no human voice.
# Run from anywhere: python scripts/video/make_video.py (needs edge-tts, playwright, ffmpeg, network).
import asyncio, base64, json, subprocess, time, urllib.request, html
from pathlib import Path
import edge_tts
from playwright.sync_api import sync_playwright

D = Path(__file__).parent
AUD, RAW, OUT = D / "aud", D / "raw", D / "out"
for p in (AUD, RAW, OUT):
    p.mkdir(exist_ok=True)
VOICE = "en-US-AndrewNeural"
API = "https://buildproof-x402.zbignevich.workers.dev"
PAGE = "https://ttimesai-star.github.io/buildproof/"
H1 = "0x5ce4d8327a23f4fa5c5e0bcc551f22ecc9285b36b5aab25eb4b9093ac92db006"
W, H = 1280, 800
FF = "ffmpeg"

SCENES = [
    ("title", "Contracts, amendments, acceptance acts and, more and more often, AI-drafted legal memos travel as PDF files by email. "
              "Months later, in a dispute, the parties argue about which file was actually signed. BuildProof gives them one shared, tamper-evident record."),
    ("how", "Only the SHA-256 hash of a document goes on chain, on Base. A record becomes attested only when every required party has signed from its own wallet, "
            "directly or with an EIP-712 signature that anyone can relay, so a party without gas can still sign. An amendment links to the contract it changes."),
    ("act", "This is the live verify page. One click downloads a synthetic acceptance act, hashes it inside the browser, and looks the hash up on Base mainnet. "
            "Attested by both expected parties, with the times taken from the chain. The file itself is never uploaded."),
    ("tampered", "Now the same act with one amount changed, from twenty-three thousand six hundred to twenty-eight thousand six hundred. "
                 "One byte differs, so the hash differs, and the registry has no record of it."),
    ("ai", "The same mechanism covers AI-generated legal work. A manifest binds the model, the prompt hash, the input documents and the output. "
           "It became attested only after the human reviewer co-signed, so you can prove which AI output a lawyer approved, and that nobody edited it afterwards."),
    ("check", "Before anyone signs, a deterministic cross-check compares each act with the contract and its amendments: arithmetic, VAT, the unit rate in force, "
              "cumulative quantities, the contract reference and bank details. A language model may only extract fields. Every finding is a rule applied to two numbers you can point at. "
              "On the sample set it finds exactly the six planted problems, with no false positives."),
    ("api", "AI agents can check any document through a pay-per-call API: one cent in USDC on Base over x402, with no account and no API key. The service is read-only and holds no keys."),
    ("legal", "Legally, BuildProof is an evidence layer, not a qualified signature. US Federal Rule of Evidence 902, paragraph 14, already relies on hash values to authenticate copies of electronic files. "
              "ESIGN and Article 25 of eIDAS do not deny an electronic record legal effect just because it is electronic. BuildProof sits next to the signature the law requires."),
    ("end", "BuildProof is an open-source prototype under the MIT license. It is unaudited, and the records on Base mainnet are synthetic demos. "
            "The next step is a pilot on real acceptance acts. The links are on screen."),
]
CAPTIONS = {
    "act": "Live verify page, Base mainnet: original acceptance act -> ATTESTED, signers match",
    "tampered": "Same act, one amount changed (23,600.00 -> 28,600.00): NOT FOUND",
    "ai": "AI legal review manifest: ATTESTED only after the human reviewer co-signed",
}


async def tts_all():
    for name, text in SCENES:
        f = AUD / f"{name}.mp3"
        if not f.exists():
            await edge_tts.Communicate(text, VOICE, rate="+4%").save(str(f))


def dur(f):
    return float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(f)]).decode().strip())


def card(page, title, lines, sub=""):
    body = "".join(f"<p style='margin:10px 0'>{l}</p>" for l in lines)
    page.set_content(f"""<html><body style="margin:0;height:100vh;display:flex;flex-direction:column;justify-content:center;
    align-items:center;background:#0b1730;color:#fff;font-family:Segoe UI,system-ui,Arial;text-align:center">
    <h1 style="font-size:44px;margin:0 0 22px">{title}</h1><div style="font-size:25px;line-height:1.45;max-width:1080px;color:#cfe0ff">{body}</div>
    <div style="font-size:18px;color:#8fb3ff;margin-top:26px">{sub}</div></body></html>""")


def term(page, text, title=""):
    page.set_content(f"<html><body style='margin:0;background:#101418;color:#d6ffd6;font:19px/1.5 Consolas,monospace;padding:36px 44px'>"
                     f"<div style='color:#8fb3ff;font:600 22px Segoe UI;margin-bottom:14px'>{html.escape(title)}</div><pre style='white-space:pre-wrap;margin:0'>{html.escape(text)}</pre></body></html>")


CAP_JS = """(t) => { let d=document.getElementById('__cap'); if(!d){d=document.createElement('div');d.id='__cap';
document.body.appendChild(d);} d.style.cssText='position:fixed;left:0;right:0;bottom:0;z-index:99999;background:rgba(10,20,40,.92);color:#fff;font:600 21px/1.35 Segoe UI,system-ui,Arial;padding:14px 28px;text-align:center';
d.textContent=t; }"""


def quote():
    req = urllib.request.Request(f"{API}/v1/attestation/{H1}", headers={"User-Agent": "curl/8.5.0"})
    try:
        urllib.request.urlopen(req, timeout=20)
        raise SystemExit("expected 402")
    except urllib.error.HTTPError as e:
        assert e.code == 402, e.code
        return json.loads(base64.b64decode(e.headers["PAYMENT-REQUIRED"]))["accepts"][0]


def main():
    asyncio.run(tts_all())
    durs = {n: dur(AUD / f"{n}.mp3") for n, _ in SCENES}
    acc = quote()
    check_out = subprocess.run(["python", "checker/crosscheck.py", "examples/pdf/act_01.pdf", "examples/pdf/act_02.pdf", "examples/pdf/act_03.pdf",
                                "examples/pdf/contract_GC-2026-014.pdf", "examples/pdf/supplementary_agreement_01.pdf"],
                               cwd=str(Path(__file__).resolve().parents[2]), capture_output=True, text=True).stdout
    check_out = "\n".join(l[:118] for l in check_out.splitlines())
    marks = []
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": W, "height": H}, record_video_dir=str(RAW), record_video_size={"width": W, "height": H})
        page = ctx.new_page()
        t0 = time.monotonic()

        def scene(name, pad=0.6):
            marks.append((name, time.monotonic() - t0))
            return durs[name] + pad

        def hold(sec, since):
            left = sec - (time.monotonic() - since)
            if left > 0:
                time.sleep(left)

        card(page, "BuildProof", ["Tamper-evident, multi-party attestations for legal documents", "and AI-generated legal outputs, on Base."],
             "BLI Legal Tech Hackathon 2 &middot; open source (MIT) &middot; all documents in this demo are synthetic")
        time.sleep(0.8)
        s = time.monotonic(); d = scene("title"); hold(d, s)

        card(page, "How it works", ["Only the SHA-256 hash goes on-chain; the file stays private.",
             "ATTESTED only when every required party signs from its wallet.",
             "Sign by transaction, or offline with EIP-712 and let anyone relay it (no gas needed).",
             "Amendments link to the contract they change (supersededBy). A party can reject with a reason hash."])
        s = time.monotonic(); d = scene("how"); hold(d, s)

        page.goto(PAGE, wait_until="networkidle")
        page.wait_for_function("document.querySelectorAll('#net option').length > 0")
        s = time.monotonic(); d = scene("act")
        page.evaluate(CAP_JS, CAPTIONS["act"])
        time.sleep(2.5)
        page.click("[data-sample='act_01.pdf']")
        page.wait_for_function("document.querySelector('#result').innerText.includes('Attested')", timeout=40000)
        time.sleep(1.2)
        page.evaluate("document.querySelector('#result').scrollIntoView({block:'center'})")
        page.evaluate(CAP_JS, CAPTIONS["act"])
        hold(d, s)

        s = time.monotonic(); d = scene("tampered")
        page.evaluate("window.scrollTo(0,0)")
        page.evaluate(CAP_JS, CAPTIONS["tampered"])
        time.sleep(1.5)
        page.click("[data-sample='act_01_tampered.pdf']")
        page.wait_for_function("document.querySelector('#result').innerText.includes('Not found')", timeout=40000)
        time.sleep(0.8)
        page.evaluate("document.querySelector('#result').scrollIntoView({block:'center'})")
        hold(d, s)

        s = time.monotonic(); d = scene("ai")
        page.evaluate("window.scrollTo(0,0)")
        page.evaluate(CAP_JS, CAPTIONS["ai"])
        time.sleep(1.5)
        page.click("[data-sample='ai_review_manifest.json']")
        page.wait_for_function("document.querySelector('#result').innerText.includes('AI-generated')", timeout=40000)
        time.sleep(0.8)
        page.evaluate("document.querySelector('#result').scrollIntoView({block:'center'})")
        hold(d, s)

        term(page, "$ python checker/crosscheck.py examples/pdf/*.pdf\n\n" + check_out,
             "Pre-signing cross-check: rules decide, the model only extracts fields")
        s = time.monotonic(); d = scene("check"); hold(d, s)

        term(page, f"$ curl -i {API}/v1/attestation/{H1[:20]}...\n\nHTTP/1.1 402 Payment Required\nPAYMENT-REQUIRED (decoded):\n"
                   f"  scheme   {acc['scheme']}\n  network  {acc['network']}   (Base mainnet)\n  asset    {acc['asset']}   (USDC)\n"
                   f"  amount   {acc['amount']}   (= $0.01)\n  payTo    {acc['payTo']}\n\n"
                   "An x402 client signs a USDC authorization and retries; the answer is\nthe verdict, the signers, the dates and the amendments.",
             "Pay-per-verify API for AI agents (x402, live on Cloudflare Workers)")
        s = time.monotonic(); d = scene("api"); hold(d, s)

        card(page, "Legal weight, stated plainly", [
            "US FRE 902(14): copies of electronic files are &ldquo;ordinarily authenticated by hash value&rdquo; (Advisory Committee note).",
            "ESIGN 15 U.S.C. &sect;7001(a) and eIDAS Art. 25(1): no denial of legal effect solely for being electronic.",
            "A wallet signature is not a qualified electronic signature (eIDAS Art. 25(2)).",
            "BuildProof is the evidence and audit layer next to the legally required signature."], "Not legal advice.")
        s = time.monotonic(); d = scene("legal"); hold(d, s)

        card(page, "BuildProof", ["Code (MIT): github.com/ttimesai-star/buildproof",
             "Verify page: ttimesai-star.github.io/buildproof",
             "x402 API: buildproof-x402.zbignevich.workers.dev",
             "Registry on Base: 0xF818e4A95BBA02c822bCa8A0CFB50a2Ae4B8eE94 (Sourcify exact match)"],
             "Status: prototype, unaudited, synthetic demo records. Next: pilot on real acceptance acts.")
        s = time.monotonic(); d = scene("end", pad=1.5); hold(d, s)
        vid = page.video.path()
        total = time.monotonic() - t0
        ctx.close(); b.close()

    # audio track: each narration placed at its scene start
    inputs, filt = [], []
    for i, (name, start) in enumerate(marks):
        inputs += ["-i", str(AUD / f"{name}.mp3")]
        ms = int(start * 1000) + 250
        filt.append(f"[{i}:a]adelay={ms}|{ms}[a{i}]")
    mix = "".join(f"[a{i}]" for i in range(len(marks))) + f"amix=inputs={len(marks)}:normalize=0[aout]"
    narr = OUT / "narration.m4a"
    subprocess.check_call([FF, "-y", "-v", "error", *inputs, "-filter_complex", ";".join(filt) + ";" + mix, "-map", "[aout]", "-c:a", "aac", "-b:a", "160k", str(narr)])
    final = OUT / "buildproof_demo_v2.mp4"
    subprocess.check_call([FF, "-y", "-v", "error", "-i", str(vid), "-i", str(narr), "-map", "0:v", "-map", "1:a", "-t", f"{total:.2f}",
                           "-c:v", "libx264", "-preset", "medium", "-crf", "22", "-pix_fmt", "yuv420p", "-r", "25", "-c:a", "copy", "-movflags", "+faststart", str(final)])
    json.dump({"marks": marks, "durs": durs, "total": total}, open(OUT / "timing.json", "w"), indent=1)
    print(final, round(total, 1), "s")


if __name__ == "__main__":
    main()
