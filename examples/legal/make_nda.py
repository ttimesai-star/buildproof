"""Render the synthetic mutual NDA document in examples/legal/nda_source.json to PDF.

Output is byte-for-byte reproducible (reportlab invariant mode).
Requires: pip install reportlab
"""
import json
import os
import sys

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "nda_source.json")
OUT = os.path.join(HERE, "nda_mutual.pdf")


def render(data, path):
    c = canvas.Canvas(path, pagesize=A4, invariant=1, pageCompression=0)
    c.setTitle(data["title"])
    c.setAuthor("BuildProof synthetic example")
    w, h = A4
    y = h - 60

    def line(text, font="Helvetica", size=10, dy=15):
        nonlocal y
        c.setFont(font, size)
        c.drawString(50, y, text)
        y -= dy

    def draw_wrapped(text, font="Helvetica", size=9, leading=12, max_width=500):
        nonlocal y
        c.setFont(font, size)
        words = text.split(" ")
        current_line = ""
        for word in words:
            test_line = current_line + (" " if current_line else "") + word
            if c.stringWidth(test_line, font, size) > max_width:
                c.drawString(50, y, current_line)
                y -= leading
                current_line = word
            else:
                current_line = test_line
        if current_line:
            c.drawString(50, y, current_line)
            y -= leading

    line("SYNTHETIC EXAMPLE - fictional parties, not a real document", "Helvetica-Oblique", 8, 20)
    line(data["title"], "Helvetica-Bold", 15, 22)
    line("Document type: Mutual Non-Disclosure Agreement", "Helvetica", 10, 15)
    line("Effective Date: %s" % data["effective_date"], "Helvetica", 10, 15)
    line("Term: %s" % data["term"], "Helvetica", 10, 15)
    line("Governing Law: %s" % data["governing_law"], "Helvetica", 10, 18)
    y -= 6

    pa, pb = data["parties"]["party_a"], data["parties"]["party_b"]
    line("Party A: %s | Reg ID: %s" % (pa["name"], pa["registration"]), font="Helvetica-Bold", size=9, dy=13)
    draw_wrapped("Address: %s" % pa["address"], size=8, leading=11)
    y -= 4
    line("Party B: %s | Reg ID: %s" % (pb["name"], pb["registration"]), font="Helvetica-Bold", size=9, dy=13)
    draw_wrapped("Address: %s" % pb["address"], size=8, leading=11)
    y -= 12

    for sec in data["sections"]:
        line(sec["heading"], "Helvetica-Bold", 10, 14)
        draw_wrapped(sec["body"], size=9, leading=12)
        y -= 8

    y -= 20
    line("For Party A: ____________________        For Party B: ____________________", size=9)
    line("Signatures are applied with the parties' wallets in BuildProof (EIP-712).", "Helvetica-Oblique", 8)
    c.showPage()
    c.save()


def main():
    data = json.load(open(SRC, encoding="utf-8"))
    render(data, OUT)
    print("wrote", os.path.relpath(OUT, HERE))


if __name__ == "__main__":
    sys.exit(main())
