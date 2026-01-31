#!/usr/bin/env python
"""
PDF Text Extraction using PyMuPDF
Fast and high-quality text extraction from PDFs
"""

import sys
import json

try:
    import pymupdf as fitz
except ImportError:
    import fitz

def extract_text(pdf_path):
    """Extract text from PDF using PyMuPDF"""
    try:
        doc = fitz.open(pdf_path)
        text = ""
        num_pages = len(doc)

        for page_num in range(num_pages):
            page = doc[page_num]
            page_text = page.get_text()
            text += page_text

        doc.close()

        return {
            "success": True,
            "text": text,
            "numPages": num_pages,
            "totalChars": len(text),
            "method": "pymupdf"
        }
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
