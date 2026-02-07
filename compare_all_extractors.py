import os
import time

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

# Camelot
try:
    import camelot
    HAS_CAMELOT = True
except ImportError:
    HAS_CAMELOT = False

def extract_with_pymupdf(pdf_path):
    try:
        start = time.time()
        doc = fitz.open(pdf_path)
        text = ""
        for page_num in range(len(doc)):
            page = doc[page_num]
            text += page.get_text()
        doc.close()
        elapsed = time.time() - start
        return text, elapsed
    except Exception as e:
        return f"Error: {e}", 0

def extract_with_pdfplumber(pdf_path):
    try:
        start = time.time()
        text = ""
        with pdfplumber.open(pdf_path) as pdf:
            for page in pdf.pages:
                page_text = page.extract_text()
                if page_text:
                    text += page_text + "\n"
        elapsed = time.time() - start
        return text, elapsed
    except Exception as e:
        return f"Error: {e}", 0

def extract_with_camelot(pdf_path):
    try:
        start = time.time()
        # Try lattice mode first (for bordered tables)
        tables = camelot.read_pdf(pdf_path, pages='1-5', flavor='stream')

        text = ""
        for i, table in enumerate(tables):
            df = table.df
            text += f"\n--- Table {i+1} ---\n"
            text += df.to_string(index=False) + "\n"

        elapsed = time.time() - start
        return text, elapsed, len(tables)
    except Exception as e:
        return f"Error: {e}", 0, 0

# Bank statement file
pdf_path = r"D:\haikus-for-codespaces\uploads\1769259313472\1769507046134-34706281 Statement.pdf"

print("=" * 80)
print("COMPARISON: PyMuPDF vs pdfplumber vs Camelot")
print("=" * 80)
print(f"File: 34706281 Statement.pdf (65 pages)")
print("=" * 80)

results = {}

# PyMuPDF
if HAS_PYMUPDF:
    print("\n### PyMuPDF ###")
    pymupdf_text, pymupdf_time = extract_with_pymupdf(pdf_path)
    results['PyMuPDF'] = {'chars': len(pymupdf_text), 'time': pymupdf_time}
    print(f"Characters: {len(pymupdf_text):,}")
    print(f"Time: {pymupdf_time:.2f}s")
    print(f"Sample (500 chars):\n{'-'*40}")
    print(pymupdf_text[:500])
else:
    print("PyMuPDF not available")

# pdfplumber
if HAS_PDFPLUMBER:
    print("\n\n### pdfplumber ###")
    pdfplumber_text, pdfplumber_time = extract_with_pdfplumber(pdf_path)
    results['pdfplumber'] = {'chars': len(pdfplumber_text), 'time': pdfplumber_time}
    print(f"Characters: {len(pdfplumber_text):,}")
    print(f"Time: {pdfplumber_time:.2f}s")
    print(f"Sample (500 chars):\n{'-'*40}")
    print(pdfplumber_text[:500])
else:
    print("pdfplumber not available")

# Camelot
if HAS_CAMELOT:
    print("\n\n### Camelot (Table Extraction) ###")
    camelot_text, camelot_time, table_count = extract_with_camelot(pdf_path)
    results['Camelot'] = {'chars': len(camelot_text), 'time': camelot_time, 'tables': table_count}
    print(f"Tables found: {table_count}")
    print(f"Characters: {len(camelot_text):,}")
    print(f"Time: {camelot_time:.2f}s")
    print(f"Sample (500 chars):\n{'-'*40}")
    print(camelot_text[:500] if len(camelot_text) > 0 else "No tables extracted")
else:
    print("\n\nCamelot not available")

# Summary
print("\n" + "=" * 80)
print("SUMMARY COMPARISON")
print("=" * 80)
print(f"{'Extractor':<15} {'Characters':>12} {'Time':>10} {'Notes'}")
print("-" * 60)
for name, data in results.items():
    notes = f"{data.get('tables', '')} tables" if 'tables' in data else ""
    print(f"{name:<15} {data['chars']:>12,} {data['time']:>9.2f}s {notes}")
