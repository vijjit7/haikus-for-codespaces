import os
import sys

# Try PyMuPDF first (best quality)
try:
    import pymupdf as fitz
    HAS_PYMUPDF = True
except ImportError:
    try:
        import fitz
        HAS_PYMUPDF = True
    except ImportError:
        HAS_PYMUPDF = False

# Try pdfplumber as fallback
try:
    import pdfplumber
    HAS_PDFPLUMBER = True
except ImportError:
    HAS_PDFPLUMBER = False

def extract_with_pymupdf(pdf_path):
    """Extract text using PyMuPDF"""
    try:
        doc = fitz.open(pdf_path)
        text = ""
        for page_num in range(len(doc)):
            page = doc[page_num]
            text += page.get_text()
        doc.close()
        return text, "pymupdf"
    except Exception as e:
        return None, str(e)

def extract_with_pdfplumber(pdf_path):
    """Extract text using pdfplumber"""
    try:
        text = ""
        with pdfplumber.open(pdf_path) as pdf:
            for page in pdf.pages:
                page_text = page.extract_text()
                if page_text:
                    text += page_text + "\n"
        return text, "pdfplumber"
    except Exception as e:
        return None, str(e)

def extract_pdf(pdf_path):
    """Extract text from PDF using best available method"""
    if not os.path.exists(pdf_path):
        return f"File not found: {pdf_path}", "error"

    # Try PyMuPDF first
    if HAS_PYMUPDF:
        text, method = extract_with_pymupdf(pdf_path)
        if text:
            return text, method

    # Fallback to pdfplumber
    if HAS_PDFPLUMBER:
        text, method = extract_with_pdfplumber(pdf_path)
        if text:
            return text, method

    return "No extraction method available", "error"

# Bank statement files
bank_statements = [
    {
        "name": "34706281 Statement.pdf",
        "path": r"D:\haikus-for-codespaces\uploads\1769259313472\1769507046134-34706281 Statement.pdf"
    },
    {
        "name": "Pragati 1 Yr Statement.pdf",
        "path": r"D:\haikus-for-codespaces\uploads\1769259313472\1769507046138-Pragati 1 Yr Statment.pdf"
    }
]

print("=" * 80)
print("BANK STATEMENT EXTRACTION USING PYTHON")
print("=" * 80)
print(f"PyMuPDF available: {HAS_PYMUPDF}")
print(f"pdfplumber available: {HAS_PDFPLUMBER}")
print("=" * 80)

for stmt in bank_statements:
    print(f"\n{'='*80}")
    print(f"FILE: {stmt['name']}")
    print(f"PATH: {stmt['path']}")
    print("=" * 80)

    text, method = extract_pdf(stmt['path'])

    print(f"Method: {method}")
    print(f"Extracted Length: {len(text)} characters")
    print("-" * 80)

    # Show first 5000 characters
    if len(text) > 5000:
        print(text[:5000])
        print(f"\n... [TRUNCATED - {len(text) - 5000} more characters] ...")
    else:
        print(text)

    print("\n")
