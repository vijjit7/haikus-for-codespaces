#!/usr/bin/env python3
"""
Decrypt a password-protected PDF and save it without password.
Usage: python decrypt_pdf.py <input_path> <password>
"""

import sys
import fitz  # PyMuPDF

def decrypt_pdf(input_path, password):
    try:
        # Open the encrypted PDF
        doc = fitz.open(input_path)

        # Check if encrypted
        if doc.is_encrypted:
            # Try to authenticate with password
            if not doc.authenticate(password):
                print("ERROR: Incorrect password", file=sys.stderr)
                sys.exit(1)

        # Save to a temporary file first, then replace
        temp_path = input_path + ".decrypted.tmp"

        # Save without encryption
        doc.save(temp_path, encryption=fitz.PDF_ENCRYPT_NONE)
        doc.close()

        # Replace original with decrypted version
        import os
        os.replace(temp_path, input_path)

        print("SUCCESS: PDF decrypted and saved")
        sys.exit(0)

    except Exception as e:
        print(f"ERROR: {str(e)}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python decrypt_pdf.py <input_path> <password>", file=sys.stderr)
        sys.exit(1)

    input_path = sys.argv[1]
    password = sys.argv[2]

    decrypt_pdf(input_path, password)
