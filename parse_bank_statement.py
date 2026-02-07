#!/usr/bin/env python3
"""
Bank Statement Parser using tabula-py for table extraction.
Usage: python parse_bank_statement.py <pdf_path> [--output json|csv]
"""

import sys
import os
import json
import re
from datetime import datetime

# Set JAVA_HOME if not set
if not os.environ.get('JAVA_HOME'):
    java_paths = [
        r'C:\Program Files\Java\jdk-21.0.10',
        r'C:\Program Files\Java\jdk-21',
        r'C:\Program Files\Java\latest'
    ]
    for path in java_paths:
        if os.path.exists(path):
            os.environ['JAVA_HOME'] = path
            break

import tabula
import pandas as pd

# Bank name patterns for Indian banks
BANK_PATTERNS = {
    'HDFC BANK': ['hdfc', 'hdfc bank'],
    'ICICI BANK': ['icici', 'icici bank'],
    'STATE BANK OF INDIA': ['sbi', 'state bank of india', 'state bank'],
    'AXIS BANK': ['axis', 'axis bank'],
    'KOTAK MAHINDRA BANK': ['kotak', 'kotak mahindra'],
    'PUNJAB NATIONAL BANK': ['pnb', 'punjab national bank'],
    'CANARA BANK': ['canara', 'canara bank'],
    'BANK OF BARODA': ['bob', 'bank of baroda', 'baroda'],
    'INDIAN OVERSEAS BANK': ['iob', 'indian overseas bank'],
    'FEDERAL BANK': ['federal', 'federal bank'],
    'BANDHAN BANK': ['bandhan', 'bandhan bank'],
    'INDUSIND BANK': ['indusind', 'indusind bank'],
    'YES BANK': ['yes bank'],
    'RBL BANK': ['rbl', 'rbl bank'],
    'IDBI BANK': ['idbi', 'idbi bank'],
    'UNION BANK': ['union bank', 'union bank of india'],
    'CENTRAL BANK': ['central bank', 'central bank of india'],
    'SOUTH INDIAN BANK': ['south indian bank', 'sib'],
    'KARUR VYSYA BANK': ['kvb', 'karur vysya'],
    'KARNATAKA BANK': ['karnataka bank'],
    'CITY UNION BANK': ['city union bank', 'cub'],
    'TAMILNAD MERCANTILE BANK': ['tmb', 'tamilnad mercantile']
}


def detect_bank_name(text):
    """Detect bank name from statement text (first 1000 chars only)."""
    header_text = text[:1000].lower()

    # Check for each bank pattern
    for bank_name, patterns in BANK_PATTERNS.items():
        for pattern in patterns:
            if pattern in header_text:
                return bank_name

    return 'Unknown Bank'


def extract_account_number(text):
    """Extract account number from statement text."""
    patterns = [
        r'(?:Account\s*(?:No|Number|#)[:\s]*|A/c\s*No[:\s]*|Acct\s*No[:\s]*)(\d{9,18})',
        r'Account[:\s]+(\d{9,18})',
        r'A/C[:\s]+(\d{9,18})'
    ]

    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            return match.group(1)

    return None


def extract_account_holder(text):
    """Extract account holder name from statement text."""
    patterns = [
        r'(?:Account\s*Holder|Customer\s*Name|Name)[:\s]+([A-Z][A-Za-z\s&.]+?)(?:\s+(?:Plot|Door|No\.|House|Flat|Building|Street|Road|Lane|Address|Branch|A/c|Account|\d|,|\n))',
        r'(?:Account\s*Holder|Customer\s*Name|Name)[:\s]+([A-Z][A-Za-z\s&.]{2,50})',
        r'(?:Mr\.|Mrs\.|Ms\.|M/S)[.\s]+([A-Z][A-Za-z\s&.]+?)(?:\s+(?:Plot|Door|No\.|House|Flat|Building|Street|Road|Lane|Address|\d|,|\n))',
        r'(?:Mr\.|Mrs\.|Ms\.|M/S)[.\s]+([A-Z][A-Za-z\s&.]{2,50})'
    ]

    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            holder = match.group(1).strip()
            # Clean up
            holder = re.sub(r'\s+(Plot|Door|No|House|Flat|Building|Street|Road|Lane|Address|Branch).*$', '', holder, flags=re.IGNORECASE).strip()
            return holder

    return None


def extract_statement_period(text):
    """Extract statement period from text."""
    patterns = [
        r'(?:Statement\s*Period|Period)[:\s]*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\s*(?:to|[-–])\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})',
        r'(?:From)[:\s]*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\s*(?:To)[:\s]*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})',
        r'(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\s*(?:to|TO|-)\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})'
    ]

    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            return {
                'from': match.group(1),
                'to': match.group(2)
            }

    return None


def parse_transactions_from_tables(tables):
    """Parse transaction data from extracted tables."""
    transactions = []

    for df in tables:
        if df is None or df.empty:
            continue

        # Try to identify transaction columns
        columns = [str(c).lower() for c in df.columns]

        # Look for date, description, amount columns
        date_col = None
        desc_col = None
        debit_col = None
        credit_col = None
        balance_col = None

        for i, col in enumerate(columns):
            if any(x in col for x in ['date', 'txn date', 'value date', 'transaction date']):
                date_col = i
            elif any(x in col for x in ['description', 'narration', 'particulars', 'remarks']):
                desc_col = i
            elif any(x in col for x in ['debit', 'withdrawal', 'dr']):
                debit_col = i
            elif any(x in col for x in ['credit', 'deposit', 'cr']):
                credit_col = i
            elif any(x in col for x in ['balance', 'closing', 'running']):
                balance_col = i

        # If we found relevant columns, extract transactions
        if date_col is not None:
            for _, row in df.iterrows():
                try:
                    txn = {
                        'date': str(row.iloc[date_col]) if date_col is not None else None,
                        'description': str(row.iloc[desc_col]) if desc_col is not None else None,
                        'debit': None,
                        'credit': None,
                        'balance': None
                    }

                    if debit_col is not None:
                        val = row.iloc[debit_col]
                        if pd.notna(val) and str(val).strip():
                            try:
                                txn['debit'] = float(str(val).replace(',', '').replace('(', '-').replace(')', ''))
                            except:
                                pass

                    if credit_col is not None:
                        val = row.iloc[credit_col]
                        if pd.notna(val) and str(val).strip():
                            try:
                                txn['credit'] = float(str(val).replace(',', '').replace('(', '-').replace(')', ''))
                            except:
                                pass

                    if balance_col is not None:
                        val = row.iloc[balance_col]
                        if pd.notna(val) and str(val).strip():
                            try:
                                txn['balance'] = float(str(val).replace(',', '').replace('(', '-').replace(')', ''))
                            except:
                                pass

                    # Only add if we have at least a date
                    if txn['date'] and txn['date'] != 'nan' and txn['date'] != 'None':
                        transactions.append(txn)
                except Exception as e:
                    continue

    return transactions


def parse_bank_statement(pdf_path):
    """Parse a bank statement PDF and extract structured data."""
    result = {
        'success': False,
        'error': None,
        'bankName': 'Unknown',
        'accountNumber': None,
        'accountHolder': None,
        'periodFrom': None,
        'periodTo': None,
        'transactions': [],
        'summary': {
            'totalDebit': 0,
            'totalCredit': 0,
            'transactionCount': 0
        }
    }

    try:
        # Extract tables using tabula-py
        tables = tabula.read_pdf(
            pdf_path,
            pages='all',
            multiple_tables=True,
            lattice=True,  # Try lattice mode first (for tables with lines)
            pandas_options={'header': None}
        )

        # If no tables found with lattice, try stream mode
        if not tables or all(df.empty for df in tables):
            tables = tabula.read_pdf(
                pdf_path,
                pages='all',
                multiple_tables=True,
                stream=True,  # Stream mode for tables without lines
                pandas_options={'header': None}
            )

        # Extract text for header info using first page
        try:
            import pdfplumber
            with pdfplumber.open(pdf_path) as pdf:
                first_page_text = pdf.pages[0].extract_text() if pdf.pages else ''
        except:
            # Fallback: extract text from first table
            first_page_text = ''
            if tables and len(tables) > 0:
                first_page_text = tables[0].to_string()

        # Extract header information
        result['bankName'] = detect_bank_name(first_page_text)
        result['accountNumber'] = extract_account_number(first_page_text)
        result['accountHolder'] = extract_account_holder(first_page_text)

        period = extract_statement_period(first_page_text)
        if period:
            result['periodFrom'] = period['from']
            result['periodTo'] = period['to']

        # Parse transactions
        result['transactions'] = parse_transactions_from_tables(tables)

        # Calculate summary
        total_debit = sum(t['debit'] or 0 for t in result['transactions'])
        total_credit = sum(t['credit'] or 0 for t in result['transactions'])

        result['summary'] = {
            'totalDebit': total_debit,
            'totalCredit': total_credit,
            'transactionCount': len(result['transactions'])
        }

        result['success'] = True

    except Exception as e:
        result['error'] = str(e)

    return result


def main():
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'Usage: python parse_bank_statement.py <pdf_path>'}))
        sys.exit(1)

    pdf_path = sys.argv[1]

    if not os.path.exists(pdf_path):
        print(json.dumps({'error': f'File not found: {pdf_path}'}))
        sys.exit(1)

    result = parse_bank_statement(pdf_path)
    print(json.dumps(result, indent=2, default=str))


if __name__ == '__main__':
    main()
