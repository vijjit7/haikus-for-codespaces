import sys
import pdfplumber
import os
import subprocess
import tempfile
import json

def extract_text_from_pdf(pdf_path):
    if not os.path.exists(pdf_path):
        print(f"Error: File not found at {pdf_path}")
        return "", 0

    try:
        full_text = ""
        num_pages = 0
        
        # Step 1: Try pdfplumber first
        with pdfplumber.open(pdf_path) as pdf:
            num_pages = len(pdf.pages)
            print(f"DEBUG: Processing {num_pages} pages with pdfplumber", file=sys.stderr)
            
            for page_num, page in enumerate(pdf.pages, 1):
                text = page.extract_text()
                if text:
                    full_text += text + "\n"
                    print(f"✓ Page {page_num}: Extracted {len(text)} characters", file=sys.stderr)
        
        # Step 2: If no text found with pdfplumber, try OCRmyPDF
        if not full_text.strip():
            print(f"⚠ No text found with pdfplumber. Starting OCR processing...", file=sys.stderr)
            print(f"========================================", file=sys.stderr)
            print(f"🔍 STARTING OCR PROCESSING", file=sys.stderr)
            print(f"========================================", file=sys.stderr)
            
            # Create temporary file for OCR output
            with tempfile.NamedTemporaryFile(suffix='.pdf', delete=False) as tmp_file:
                ocr_output = tmp_file.name
            
            try:
                # Run OCRmyPDF to add text layer
                print(f"Running OCRmyPDF on: {pdf_path}", file=sys.stderr)
                result = subprocess.run(
                    ['ocrmypdf', '--force-ocr', '--verbose', '1', pdf_path, ocr_output],
                    text=True,
                    timeout=120,  # 2 minute timeout
                    stderr=subprocess.PIPE
                )
                
                # Print OCRmyPDF output
                if result.stderr:
                    print(f"\nOCRmyPDF Output:", file=sys.stderr)
                    print(result.stderr, file=sys.stderr)
                
                if result.returncode == 0 and os.path.exists(ocr_output):
                    print(f"✓ OCRmyPDF completed successfully", file=sys.stderr)
                    print(f"========================================", file=sys.stderr)
                    print(f"📄 EXTRACTING TEXT FROM OCR'D PDF", file=sys.stderr)
                    print(f"========================================", file=sys.stderr)
                    
                    # Extract text from OCR'd PDF
                    with pdfplumber.open(ocr_output) as pdf:
                        num_pages = len(pdf.pages)
                        for page_num, page in enumerate(pdf.pages, 1):
                            text = page.extract_text()
                            if text:
                                full_text += text + "\n"
                                print(f"✓ Page {page_num}: Extracted {len(text)} characters", file=sys.stderr)
                    
                    print(f"========================================", file=sys.stderr)
                    print(f"✓ TOTAL EXTRACTED: {len(full_text)} characters", file=sys.stderr)
                    print(f"========================================", file=sys.stderr)
                else:
                    print(f"✗ OCRmyPDF failed with code {result.returncode}", file=sys.stderr)
            
            finally:
                # Clean up temporary file
                if os.path.exists(ocr_output):
                    os.remove(ocr_output)
        else:
            # Text was found with pdfplumber
            print(f"========================================", file=sys.stderr)
            print(f"✓ TOTAL EXTRACTED: {len(full_text)} characters (pdfplumber)", file=sys.stderr)
            print(f"========================================", file=sys.stderr)
        
        return full_text, num_pages
    except Exception as e:
        print(f"Error processing PDF: {str(e)}", file=sys.stderr)
        return "", 0

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python extract_pdf.py <pdf_path>")
        sys.exit(1)
        
    pdf_path = sys.argv[1]
    print(f"DEBUG: Processing {pdf_path}", file=sys.stderr)
    extracted_text, num_pages = extract_text_from_pdf(pdf_path)
    print(f"DEBUG: Extraction complete. Length: {len(extracted_text)}, Pages: {num_pages}", file=sys.stderr)
    
    # Output JSON with text and page count for Node.js to parse
    output = {
        "text": extracted_text,
        "numPages": num_pages
    }
    print(json.dumps(output))
