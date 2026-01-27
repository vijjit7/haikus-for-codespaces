"""
FastAPI PDF Extraction Service
Provides a 2-tier fallback system:
1. Primary: PyMuPDF (fitz) - Best quality
2. Secondary: pdfplumber - Falls back if PyMuPDF fails
"""

from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import fitz  # PyMuPDF
import pdfplumber
import io
import logging
from typing import Dict, Any
import traceback
import uvicorn

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="PDF Extraction Service", version="1.0.0")

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def extract_with_pymupdf(pdf_bytes: bytes) -> Dict[str, Any]:
    """
    Extract text using PyMuPDF (fitz) - Primary method
    Provides the best quality text extraction
    """
    try:
        logger.info("Attempting extraction with PyMuPDF...")
        
        # Open PDF from bytes
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        
        full_text = ""
        num_pages = len(doc)
        pages_data = []
        
        for page_num in range(num_pages):
            page = doc[page_num]
            
            # Extract text
            page_text = page.get_text()
            full_text += page_text + "\n"
            
            # Get page info
            pages_data.append({
                "page_num": page_num + 1,
                "text": page_text,
                "char_count": len(page_text)
            })
            
            logger.info(f"Page {page_num + 1}: Extracted {len(page_text)} characters")
        
        doc.close()
        
        result = {
            "success": True,
            "method": "pymupdf",
            "text": full_text,
            "num_pages": num_pages,
            "total_chars": len(full_text),
            "pages": pages_data
        }
        
        logger.info(f"✓ PyMuPDF extraction successful: {len(full_text)} characters from {num_pages} pages")
        return result
        
    except Exception as e:
        logger.error(f"PyMuPDF extraction failed: {str(e)}")
        logger.error(traceback.format_exc())
        raise Exception(f"PyMuPDF failed: {str(e)}")


def extract_with_pdfplumber(pdf_bytes: bytes) -> Dict[str, Any]:
    """
    Extract text using pdfplumber - Secondary fallback method
    """
    try:
        logger.info("Attempting extraction with pdfplumber...")
        
        # Open PDF from bytes
        pdf_file = io.BytesIO(pdf_bytes)
        
        full_text = ""
        pages_data = []
        
        with pdfplumber.open(pdf_file) as pdf:
            num_pages = len(pdf.pages)
            
            for page_num, page in enumerate(pdf.pages, 1):
                page_text = page.extract_text() or ""
                full_text += page_text + "\n"
                
                pages_data.append({
                    "page_num": page_num,
                    "text": page_text,
                    "char_count": len(page_text)
                })
                
                logger.info(f"Page {page_num}: Extracted {len(page_text)} characters")
        
        result = {
            "success": True,
            "method": "pdfplumber",
            "text": full_text,
            "num_pages": num_pages,
            "total_chars": len(full_text),
            "pages": pages_data
        }
        
        logger.info(f"✓ pdfplumber extraction successful: {len(full_text)} characters from {num_pages} pages")
        return result
        
    except Exception as e:
        logger.error(f"pdfplumber extraction failed: {str(e)}")
        logger.error(traceback.format_exc())
        raise Exception(f"pdfplumber failed: {str(e)}")


@app.get("/")
async def root():
    """Health check endpoint"""
    return {
        "service": "PDF Extraction Service",
        "status": "running",
        "version": "1.0.0",
        "methods": ["pymupdf", "pdfplumber"]
    }


@app.post("/extract")
async def extract_pdf(file: UploadFile = File(...)):
    """
    Extract text from PDF with 2-tier fallback:
    1. PyMuPDF (fitz) - Primary
    2. pdfplumber - Secondary
    """
    try:
        # Validate file type
        if not file.filename.lower().endswith('.pdf'):
            raise HTTPException(status_code=400, detail="File must be a PDF")
        
        # Read file content
        pdf_bytes = await file.read()
        logger.info(f"Processing PDF: {file.filename} ({len(pdf_bytes)} bytes)")
        
        # Try PyMuPDF first (Primary method)
        try:
            result = extract_with_pymupdf(pdf_bytes)
            
            # Check if text was extracted
            if result["text"].strip():
                return JSONResponse(content=result)
            else:
                logger.warning("PyMuPDF returned empty text, trying pdfplumber...")
                
        except Exception as pymupdf_error:
            logger.warning(f"PyMuPDF failed: {str(pymupdf_error)}")
        
        # Fallback to pdfplumber (Secondary method)
        try:
            result = extract_with_pdfplumber(pdf_bytes)
            
            if result["text"].strip():
                return JSONResponse(content=result)
            else:
                # No text extracted by either method
                return JSONResponse(content={
                    "success": False,
                    "method": "none",
                    "text": "",
                    "num_pages": 0,
                    "total_chars": 0,
                    "pages": [],
                    "error": "No text could be extracted from PDF (may be image-based)"
                })
                
        except Exception as pdfplumber_error:
            logger.error(f"Both extraction methods failed")
            raise HTTPException(
                status_code=500,
                detail=f"All extraction methods failed. Last error: {str(pdfplumber_error)}"
            )
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error: {str(e)}")
        logger.error(traceback.format_exc())
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/extract/pymupdf")
async def extract_with_pymupdf_only(file: UploadFile = File(...)):
    """Extract text using only PyMuPDF"""
    try:
        if not file.filename.lower().endswith('.pdf'):
            raise HTTPException(status_code=400, detail="File must be a PDF")
        
        pdf_bytes = await file.read()
        result = extract_with_pymupdf(pdf_bytes)
        return JSONResponse(content=result)
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/extract/pdfplumber")
async def extract_with_pdfplumber_only(file: UploadFile = File(...)):
    """Extract text using only pdfplumber"""
    try:
        if not file.filename.lower().endswith('.pdf'):
            raise HTTPException(status_code=400, detail="File must be a PDF")
        
        pdf_bytes = await file.read()
        result = extract_with_pdfplumber(pdf_bytes)
        return JSONResponse(content=result)
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    logger.info("Starting PDF Extraction Service on port 5001...")
    uvicorn.run(app, host="0.0.0.0", port=5001)
