"""Render the synthetic documents in examples/source/documents.json to PDF.

Output is byte-for-byte reproducible (reportlab invariant mode), so the SHA-256
hashes in the README stay valid. Requires: pip install reportlab
"""
import json
import os
import sys

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "source", "documents.json")
OUT = os.path.join(HERE, "pdf")


def money(x):
    return "%.2f" % x


def row(n, name, unit, qty, rate, amount):
    return "%-3s %-30s %-4s %10s %9s %11s" % (n, name[:30], unit, "%.3f" % qty, money(rate), money(amount))


def render(doc, parties, path):
    c = canvas.Canvas(path, pagesize=A4, invariant=1, pageCompression=0)
    c.setTitle(doc["title"])
    c.setAuthor("BuildProof synthetic example")
    w, h = A4
    y = h - 60

    def line(text, font="Helvetica", size=10, dy=15):
        nonlocal y
        c.setFont(font, size)
        c.drawString(50, y, text)
        y -= dy

    line("SYNTHETIC EXAMPLE - fictional parties, not a real document", "Helvetica-Oblique", 8, 20)
    line(doc["title"], "Helvetica-Bold", 15, 22)
    line("Document type: %s" % doc["kind"])
    if doc["kind"] == "Contract":
        line("Contract No.: %s" % doc["number"])
    else:
        line("Document No.: %s" % doc["number"])
        line("Contract No.: %s" % doc["contract_ref"])
    line("Date: %s" % doc["date"])
    if "term" in doc:
        line("Term: %s to %s" % tuple(doc["term"]))
    if "period" in doc:
        line("Period: %s to %s" % tuple(doc["period"]))
    if "object" in doc:
        line("Object: %s" % doc["object"])
    y -= 6
    cl, co = parties["client"], parties["contractor"]
    co_iban = doc.get("contractor_iban", co["iban"])
    line("Client: %s | Tax ID: %s | IBAN: %s" % (cl["name"], cl["tax_id"], cl["iban"]), size=9)
    line("Contractor: %s | Tax ID: %s | IBAN: %s" % (co["name"], co["tax_id"], co_iban), size=9)
    y -= 10

    if doc["kind"] == "Supplementary Agreement":
        line("The parties agree to amend the contract as follows:", dy=18)
        for ch in doc["changes"]:
            if ch["field"] == "quantity":
                line("Change: item %d quantity %.3f -> %.3f effective %s (%s)"
                     % (ch["item"], ch["from"], ch["to"], ch["effective"], ch["why"]), size=9)
            else:
                line("Change: item %d rate %s -> %s effective %s (%s)"
                     % (ch["item"], money(ch["from"]), money(ch["to"]), ch["effective"], ch["why"]), size=9)
        y -= 8
        line("New contract subtotal: %s" % money(doc["new_subtotal"]))
        line("New contract VAT: %s" % money(doc["new_vat"]))
        line("New contract total: %s" % money(doc["new_total"]))
    else:
        line(row("No", "Work item", "Unit", 0, 0, 0).replace("0.000", "  Qty").replace("0.00", "Rate", 1)
             .replace("0.00", "Amount"), "Courier-Bold", 9, 13)
        for ln in doc["lines"]:
            line(row(*ln), "Courier", 9, 13)
        y -= 8
        line("Subtotal: %s" % money(doc["subtotal"]))
        line("VAT %d%%: %s" % (doc["vat_rate"], money(doc["vat"])))
        line("Total: %s" % money(doc["total"]))
    y -= 30
    line("For the Client: ____________________        For the Contractor: ____________________", size=9)
    line("Signatures are applied with the parties' wallets in BuildProof (EIP-712).", "Helvetica-Oblique", 8)
    c.showPage()
    c.save()


def main():
    data = json.load(open(SRC, encoding="utf-8"))
    os.makedirs(OUT, exist_ok=True)
    for doc in data["documents"]:
        p = os.path.join(OUT, doc["file"])
        render(doc, data["parties"], p)
        print("wrote", os.path.relpath(p, HERE))


if __name__ == "__main__":
    sys.exit(main())
