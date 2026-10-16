"""Copy the demo files the hosted verify page offers as one-click samples into docs/samples/.

act_01_tampered.pdf is act_01.pdf with one amount changed (23600.00 -> 28600.00, same length,
so the PDF stays valid and opens normally). Its SHA-256 differs, so the page shows NOT FOUND.
Run from the repository root: python scripts/make_samples.py
"""
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "samples"


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(ROOT / "examples/pdf/act_01.pdf", OUT / "act_01.pdf")
    shutil.copyfile(ROOT / "examples/legal/ai_review_manifest.json", OUT / "ai_review_manifest.json")
    src = (ROOT / "examples/pdf/act_01.pdf").read_bytes()
    i = src.find(b"23600.00")
    assert i > 0, "amount not found in the PDF stream"
    (OUT / "act_01_tampered.pdf").write_bytes(src[:i] + b"28600.00" + src[i + 8:])
    print("samples written to", OUT)


if __name__ == "__main__":
    main()
