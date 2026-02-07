import sys
import pdfplumber
import os
import subprocess
import tempfile
import json

def extract_text_from_pdf(pdf_path, extract_tables=False):
    if not os.path.exists(pdf_path):
        print(f"Error: File not found at {pdf_path}", file=sys.stderr)
        return "", 0, []

    try:
        full_text = ""
        num_pages = 0
        all_tables = []

        # Step 1: Try pdfplumber first
        pages_without_text = []
        with pdfplumber.open(pdf_path) as pdf:
            num_pages = len(pdf.pages)
            print(f"DEBUG: Processing {num_pages} pages with pdfplumber", file=sys.stderr)

            for page_num, page in enumerate(pdf.pages, 1):
                text = page.extract_text()
                if text and len(text.strip()) > 50:  # Meaningful text threshold
                    full_text += text + "\n"
                    print(f"✓ Page {page_num}: Extracted {len(text)} characters", file=sys.stderr)
                else:
                    pages_without_text.append(page_num)
                    print(f"⚠ Page {page_num}: No/minimal text (likely scanned image)", file=sys.stderr)

                # Extract tables if requested
                if extract_tables:
                    tables = page.extract_tables()
                    if tables:
                        print(f"📊 Page {page_num}: Found {len(tables)} table(s)", file=sys.stderr)
                        for table_idx, table in enumerate(tables):
                            if table and len(table) > 0:
                                # Clean up table data
                                cleaned_table = []
                                for row in table:
                                    if row:
                                        cleaned_row = [cell.strip() if cell else "" for cell in row]
                                        # Skip completely empty rows
                                        if any(cleaned_row):
                                            cleaned_table.append(cleaned_row)

                                if cleaned_table:
                                    all_tables.append({
                                        "page": page_num,
                                        "table_index": table_idx,
                                        "rows": cleaned_table,
                                        "row_count": len(cleaned_table),
                                        "col_count": max(len(row) for row in cleaned_table) if cleaned_table else 0
                                    })

        # Step 2: If no text found OR some pages have no text (mixed scanned/text PDF), try OCRmyPDF
        # Run OCR if more than 20% of pages have no text, or if no text at all
        needs_ocr = not full_text.strip() or (len(pages_without_text) > 0 and len(pages_without_text) >= num_pages * 0.2)

        if needs_ocr:
            print(f"⚠ No text found with pdfplumber. Starting OCR processing...", file=sys.stderr)
            print(f"========================================", file=sys.stderr)
            print(f"🔍 STARTING OCR PROCESSING (OCRmyPDF + Tesseract)", file=sys.stderr)
            print(f"========================================", file=sys.stderr)

            # Create temporary file for OCR output
            with tempfile.NamedTemporaryFile(suffix='.pdf', delete=False) as tmp_file:
                ocr_output = tmp_file.name

            try:
                # Run OCRmyPDF to add text layer
                print(f"Running OCRmyPDF on: {pdf_path}", file=sys.stderr)

                # Use full path to tesseract if needed
                tesseract_path = r"C:\Program Files\Tesseract-OCR\tesseract.exe"

                env = os.environ.copy()
                env['PATH'] = r"C:\Program Files\Tesseract-OCR;" + env.get('PATH', '')

                result = subprocess.run(
                    [sys.executable, '-m', 'ocrmypdf', '--force-ocr', '--tesseract-timeout', '300', pdf_path, ocr_output],
                    capture_output=True,
                    text=True,
                    timeout=300,  # 5 minute timeout
                    env=env
                )

                # Print OCRmyPDF output
                if result.stderr:
                    print(f"\nOCRmyPDF Output:", file=sys.stderr)
                    for line in result.stderr.split('\n')[:20]:  # First 20 lines
                        print(line, file=sys.stderr)

                if result.returncode == 0 and os.path.exists(ocr_output):
                    print(f"✓ OCRmyPDF completed successfully", file=sys.stderr)
                    print(f"========================================", file=sys.stderr)
                    print(f"📄 EXTRACTING TEXT FROM OCR'D PDF", file=sys.stderr)
                    print(f"========================================", file=sys.stderr)

                    # Extract text and tables from OCR'd PDF
                    with pdfplumber.open(ocr_output) as pdf:
                        num_pages = len(pdf.pages)
                        for page_num, page in enumerate(pdf.pages, 1):
                            text = page.extract_text()
                            if text:
                                full_text += text + "\n"
                                print(f"✓ Page {page_num}: Extracted {len(text)} characters", file=sys.stderr)

                            # Extract tables from OCR'd PDF too
                            if extract_tables:
                                tables = page.extract_tables()
                                if tables:
                                    print(f"📊 Page {page_num}: Found {len(tables)} table(s) from OCR", file=sys.stderr)
                                    for table_idx, table in enumerate(tables):
                                        if table and len(table) > 0:
                                            cleaned_table = []
                                            for row in table:
                                                if row:
                                                    cleaned_row = [cell.strip() if cell else "" for cell in row]
                                                    if any(cleaned_row):
                                                        cleaned_table.append(cleaned_row)
                                            if cleaned_table:
                                                all_tables.append({
                                                    "page": page_num,
                                                    "table_index": table_idx,
                                                    "rows": cleaned_table,
                                                    "row_count": len(cleaned_table),
                                                    "col_count": max(len(row) for row in cleaned_table) if cleaned_table else 0
                                                })

                    print(f"========================================", file=sys.stderr)
                    print(f"✓ TOTAL EXTRACTED: {len(full_text)} characters", file=sys.stderr)
                    print(f"========================================", file=sys.stderr)
                else:
                    print(f"✗ OCRmyPDF failed with code {result.returncode}", file=sys.stderr)
                    print(f"stderr: {result.stderr}", file=sys.stderr)

            except subprocess.TimeoutExpired:
                print(f"✗ OCRmyPDF timed out after 5 minutes", file=sys.stderr)
            except Exception as e:
                print(f"✗ OCRmyPDF error: {e}", file=sys.stderr)
            finally:
                # Clean up temporary file
                if os.path.exists(ocr_output):
                    try:
                        os.remove(ocr_output)
                    except:
                        pass
        else:
            # Text was found with pdfplumber
            print(f"========================================", file=sys.stderr)
            print(f"✓ TOTAL EXTRACTED: {len(full_text)} characters (pdfplumber)", file=sys.stderr)
            if extract_tables and all_tables:
                print(f"📊 TOTAL TABLES: {len(all_tables)}", file=sys.stderr)
            print(f"========================================", file=sys.stderr)

        return full_text, num_pages, all_tables
    except Exception as e:
        print(f"Error processing PDF: {str(e)}", file=sys.stderr)
        return "", 0, []

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python extract_pdf.py <pdf_path> [--tables]")
        sys.exit(1)

    pdf_path = sys.argv[1]
    extract_tables = "--tables" in sys.argv

    print(f"DEBUG: Processing {pdf_path}", file=sys.stderr)
    if extract_tables:
        print(f"DEBUG: Table extraction ENABLED", file=sys.stderr)

    extracted_text, num_pages, tables = extract_text_from_pdf(pdf_path, extract_tables)
    print(f"DEBUG: Extraction complete. Length: {len(extracted_text)}, Pages: {num_pages}, Tables: {len(tables)}", file=sys.stderr)

    # Output JSON with text, page count, and tables for Node.js to parse
    output = {
        "text": extracted_text,
        "numPages": num_pages,
        "tables": tables
    }
    print(json.dumps(output))
