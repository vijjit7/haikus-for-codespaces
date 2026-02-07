#!/usr/bin/env python
"""
PDF Text Extraction using PyMuPDF
Fast and high-quality text extraction from PDFs
Falls back to Tesseract OCR for scanned/image-based pages
"""

import sys
import json

try:
    import pymupdf as fitz
except ImportError:
    import fitz

# Try to import OCR dependencies
try:
    import pytesseract
    from PIL import Image
    import io
    HAS_OCR = True
except ImportError:
    HAS_OCR = False

MIN_CHARS_PER_PAGE = 100  # Below this, page is likely scanned/image

def ocr_page(page):
    """Render a PDF page to image and OCR it with Tesseract"""
    try:
        pix = page.get_pixmap(dpi=250)
        img = Image.open(io.BytesIO(pix.tobytes("png")))
        page_text = pytesseract.image_to_string(img)
        return page_text
    except Exception as e:
        print(f"OCR error: {e}", file=sys.stderr)
        return ""

def extract_text(pdf_path):
    """Extract text from PDF using PyMuPDF, with Tesseract OCR fallback for scanned pages"""
    try:
        doc = fitz.open(pdf_path)
        text = ""
        num_pages = len(doc)
        ocr_pages = 0

        for page_num in range(num_pages):
            page = doc[page_num]
            page_text = page.get_text()

            # If page has very little text and OCR is available, try OCR
            if HAS_OCR and len(page_text.strip()) < MIN_CHARS_PER_PAGE:
                ocr_text = ocr_page(page)
                if len(ocr_text.strip()) > len(page_text.strip()):
                    page_text = ocr_text
                    ocr_pages += 1

            text += page_text

        doc.close()

        result = {
            "success": True,
            "text": text,
            "numPages": num_pages,
            "totalChars": len(text),
            "method": "pymupdf"
        }
        if ocr_pages > 0:
            result["ocrPages"] = ocr_pages
            print(f"OCR applied to {ocr_pages}/{num_pages} pages", file=sys.stderr)

        return result
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "text": "",
            "numPages": 0,
            "method": "pymupdf"
        }

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "No PDF path provided"}))
        sys.exit(1)

    pdf_path = sys.argv[1]
    result = extract_text(pdf_path)
    print(json.dumps(result))
