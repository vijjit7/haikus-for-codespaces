import os

# PyMuPDF
try:
    import pymupdf as fitz
    HAS_PYMUPDF = True
except ImportError:
    try:
        import fitz
        HAS_PYMUPDF = True
    except ImportError:
        HAS_PYMUPDF = False

# pdfplumber
try:
    import pdfplumber
    HAS_PDFPLUMBER = True
except ImportError:
    HAS_PDFPLUMBER = False

def extract_with_pymupdf(pdf_path):
    try:
        doc = fitz.open(pdf_path)
        text = ""
        for page_num in range(len(doc)):
            page = doc[page_num]
            text += page.get_text()
        doc.close()
        return text
    except Exception as e:
        return f"Error: {e}"

def extract_with_pdfplumber(pdf_path):
    try:
        text = ""
        with pdfplumber.open(pdf_path) as pdf:
            for page in pdf.pages:
                page_text = page.extract_text()
                if page_text:
                    text += page_text + "\n"
        return text
    except Exception as e:
        return f"Error: {e}"

# Bank statement file
pdf_path = r"D:\haikus-for-codespaces\uploads\1769259313472\1769507046134-34706281 Statement.pdf"

print("=" * 80)
print("COMPARISON: PyMuPDF vs pdfplumber")
print("=" * 80)
print(f"File: 34706281 Statement.pdf")
print("=" * 80)

# PyMuPDF
print("\n### PyMuPDF ###")
pymupdf_text = extract_with_pymupdf(pdf_path)
print(f"Characters extracted: {len(pymupdf_text)}")
print(f"First 2000 chars:\n{'-'*40}")
print(pymupdf_text[:2000])

# pdfplumber
print("\n\n### pdfplumber ###")
pdfplumber_text = extract_with_pdfplumber(pdf_path)
print(f"Characters extracted: {len(pdfplumber_text)}")
print(f"First 2000 chars:\n{'-'*40}")
print(pdfplumber_text[:2000])

print("\n" + "=" * 80)
print("SUMMARY")
print("=" * 80)
print(f"PyMuPDF:    {len(pymupdf_text):,} characters")
print(f"pdfplumber: {len(pdfplumber_text):,} characters")
print(f"Difference: {abs(len(pymupdf_text) - len(pdfplumber_text)):,} characters")
print(f"Winner:     {'PyMuPDF' if len(pymupdf_text) > len(pdfplumber_text) else 'pdfplumber'}")
