#!/bin/bash

# ==============================================
# PDF Extraction Service Startup Script
# ==============================================
# This script starts the Python FastAPI service for PDF extraction
# The service runs on port 5001 and provides:
# - Primary: PyMuPDF (fitz) extraction
# - Secondary: pdfplumber fallback

echo "=========================================="
echo "  PDF Extraction Service Startup"
echo "=========================================="

# Check if Python is available
if ! command -v python3 &> /dev/null; then
    echo "❌ Python3 not found. Please install Python 3.8+"
    exit 1
fi

echo "✓ Python3 found: $(python3 --version)"

# Check if required packages are installed
echo ""
echo "Checking dependencies..."

# Install requirements if needed
if [ -f "requirements.txt" ]; then
    echo "Installing Python dependencies..."
    pip3 install -r requirements.txt --quiet
    if [ $? -eq 0 ]; then
        echo "✓ Dependencies installed"
    else
        echo "⚠ Some dependencies may have failed to install"
    fi
fi

# Start the FastAPI service
echo ""
echo "=========================================="
echo "  Starting PDF Extraction Service"
echo "  URL: http://localhost:5001"
echo "=========================================="
echo ""

# Run the service
python3 pdf_service.py
