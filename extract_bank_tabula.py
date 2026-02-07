"""
Bank Statement Parser using Tabula-py
Extracts tabular data from bank statement PDFs using tabula-py (Java-based table extraction)

Requirements:
    pip install tabula-py pandas
    Java Runtime Environment (JRE) must be installed
"""

import os
import sys
import json
from datetime import datetime

try:
    import tabula
    HAS_TABULA = True
except ImportError:
    HAS_TABULA = False
    print("Warning: tabula-py not installed. Run: pip install tabula-py")

try:
    import pandas as pd
    HAS_PANDAS = True
except ImportError:
    HAS_PANDAS = False
    print("Warning: pandas not installed. Run: pip install pandas")


def extract_tables_from_pdf(pdf_path, pages='all', output_format='dataframe'):
    """
    Extract tables from a PDF file using tabula-py
    
    Args:
        pdf_path: Path to the PDF file
        pages: Page numbers to extract ('all', or specific pages like '1,2,3' or '1-5')
        output_format: 'dataframe' for pandas DataFrames, 'json' for JSON format
    
    Returns:
        List of extracted tables (as DataFrames or dicts)
    """
    if not HAS_TABULA:
        raise ImportError("tabula-py is not installed. Run: pip install tabula-py")
    
    if not os.path.exists(pdf_path):
        raise FileNotFoundError(f"PDF file not found: {pdf_path}")
    
    try:
        # Extract all tables from PDF
        tables = tabula.read_pdf(
            pdf_path,
            pages=pages,
            multiple_tables=True,
            pandas_options={'header': None},  # Don't assume first row is header
            lattice=True  # Use lattice mode for tables with clear borders
        )
        
        if not tables:
            # Try stream mode if lattice mode didn't find tables
            tables = tabula.read_pdf(
                pdf_path,
                pages=pages,
                multiple_tables=True,
                pandas_options={'header': None},
                stream=True  # Stream mode for tables without clear borders
            )
        
        if output_format == 'json':
            return [table.to_dict(orient='records') for table in tables]
        
        return tables
        
    except Exception as e:
        print(f"Error extracting tables: {e}")
        return []


def parse_bank_statement(pdf_path, bank_type='auto'):
    """
    Parse a bank statement PDF and extract transaction data
    
    Args:
        pdf_path: Path to the bank statement PDF
        bank_type: Type of bank statement ('hdfc', 'sbi', 'icici', 'auto')
    
    Returns:
        Dictionary with parsed statement data
    """
    tables = extract_tables_from_pdf(pdf_path)
    
    if not tables:
        return {"error": "No tables found in PDF", "tables": []}
    
    result = {
        "file": os.path.basename(pdf_path),
        "extraction_date": datetime.now().isoformat(),
        "bank_type": bank_type,
        "tables_found": len(tables),
        "tables": [],
        "transactions": []
    }
    
    for i, table in enumerate(tables):
        if isinstance(table, pd.DataFrame) and not table.empty:
            # Clean the table
            table = table.dropna(how='all')  # Remove empty rows
            table = table.dropna(axis=1, how='all')  # Remove empty columns
            
            # Convert to records
            table_data = {
                "table_index": i,
                "rows": len(table),
                "columns": len(table.columns),
                "data": table.values.tolist(),
                "column_names": [str(col) for col in table.columns.tolist()]
            }
            result["tables"].append(table_data)
            
            # Try to identify transaction rows
            transactions = identify_transactions(table, bank_type)
            if transactions:
                result["transactions"].extend(transactions)
    
    return result


def identify_transactions(df, bank_type='auto'):
    """
    Identify transaction rows from a DataFrame
    
    Args:
        df: pandas DataFrame with table data
        bank_type: Type of bank for specific parsing logic
    
    Returns:
        List of transaction dictionaries
    """
    transactions = []
    
    if df.empty:
        return transactions
    
    # Common date patterns in bank statements
    date_patterns = [
        r'\d{2}/\d{2}/\d{4}',  # DD/MM/YYYY
        r'\d{2}-\d{2}-\d{4}',  # DD-MM-YYYY
        r'\d{2}/\d{2}/\d{2}',  # DD/MM/YY
        r'\d{2}-\d{2}-\d{2}',  # DD-MM-YY
        r'\d{2}\s+\w{3}\s+\d{4}',  # DD Mon YYYY
        r'\d{2}\w{3}\d{4}',  # DDMonYYYY
    ]
    
    import re
    combined_pattern = '|'.join(date_patterns)
    
    for idx, row in df.iterrows():
        row_str = ' '.join([str(cell) for cell in row.values if pd.notna(cell)])
        
        # Check if row contains a date (likely a transaction)
        if re.search(combined_pattern, row_str):
            # Try to extract transaction details
            transaction = {
                "row_index": int(idx) if isinstance(idx, (int, float)) else str(idx),
                "raw_data": row.values.tolist(),
                "raw_text": row_str
            }
            
            # Try to identify amount (look for numbers with commas/decimals)
            amounts = re.findall(r'[\d,]+\.?\d*', row_str)
            if amounts:
                # Filter out dates and small numbers
                valid_amounts = [a for a in amounts if len(a.replace(',', '').replace('.', '')) > 2]
                if valid_amounts:
                    transaction["amounts"] = valid_amounts
            
            transactions.append(transaction)
    
    return transactions


def export_to_csv(result, output_path):
    """
    Export extracted tables to CSV files
    
    Args:
        result: Parsed result dictionary
        output_path: Directory to save CSV files
    """
    if not os.path.exists(output_path):
        os.makedirs(output_path)
    
    base_name = os.path.splitext(result["file"])[0]
    
    for i, table in enumerate(result["tables"]):
        csv_path = os.path.join(output_path, f"{base_name}_table_{i+1}.csv")
        df = pd.DataFrame(table["data"], columns=table.get("column_names"))
        df.to_csv(csv_path, index=False)
        print(f"Exported: {csv_path}")
    
    # Export transactions
    if result["transactions"]:
        trans_path = os.path.join(output_path, f"{base_name}_transactions.csv")
        trans_df = pd.DataFrame(result["transactions"])
        trans_df.to_csv(trans_path, index=False)
        print(f"Exported: {trans_path}")


def export_to_json(result, output_path):
    """
    Export extracted data to JSON file
    
    Args:
        result: Parsed result dictionary
        output_path: Path to save JSON file
    """
    # Convert any remaining non-serializable objects
    def make_serializable(obj):
        if isinstance(obj, (pd.DataFrame, pd.Series)):
            return obj.to_dict()
        if hasattr(obj, 'tolist'):
            return obj.tolist()
        if pd.isna(obj):
            return None
        return obj
    
    serializable_result = json.loads(
        json.dumps(result, default=make_serializable)
    )
    
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(serializable_result, f, indent=2, ensure_ascii=False)
    
    print(f"Exported JSON: {output_path}")


def main():
    """Main function to process bank statements"""
    
    if not HAS_TABULA or not HAS_PANDAS:
        print("\nMissing dependencies. Please install:")
        print("  pip install tabula-py pandas")
        print("\nAlso ensure Java Runtime Environment (JRE) is installed.")
        sys.exit(1)
    
    # Default bank statement paths (modify as needed)
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
    
    # Check for command line arguments
    if len(sys.argv) > 1:
        pdf_path = sys.argv[1]
        if os.path.exists(pdf_path):
            bank_statements = [{"name": os.path.basename(pdf_path), "path": pdf_path}]
        else:
            print(f"File not found: {pdf_path}")
            sys.exit(1)
    
    print("=" * 80)
    print("BANK STATEMENT EXTRACTION USING TABULA-PY")
    print("=" * 80)
    print(f"Tabula available: {HAS_TABULA}")
    print(f"Pandas version: {pd.__version__ if HAS_PANDAS else 'N/A'}")
    print("=" * 80)
    
    for stmt in bank_statements:
        print(f"\n{'='*80}")
        print(f"FILE: {stmt['name']}")
        print(f"PATH: {stmt['path']}")
        print("=" * 80)
        
        if not os.path.exists(stmt['path']):
            print(f"ERROR: File not found - {stmt['path']}")
            continue
        
        try:
            # Parse the bank statement
            result = parse_bank_statement(stmt['path'])
            
            print(f"\nTables found: {result['tables_found']}")
            print(f"Transactions identified: {len(result['transactions'])}")
            
            # Display table summaries
            for i, table in enumerate(result["tables"]):
                print(f"\n--- Table {i+1} ({table['rows']} rows x {table['columns']} columns) ---")
                # Show first 5 rows
                for row in table["data"][:5]:
                    print("  " + " | ".join([str(cell)[:30] for cell in row if cell is not None]))
                if table['rows'] > 5:
                    print(f"  ... [{table['rows'] - 5} more rows]")
            
            # Display sample transactions
            if result["transactions"]:
                print(f"\n--- Sample Transactions ---")
                for trans in result["transactions"][:5]:
                    print(f"  {trans.get('raw_text', '')[:100]}...")
                if len(result["transactions"]) > 5:
                    print(f"  ... [{len(result['transactions']) - 5} more transactions]")
            
            # Export options
            output_dir = os.path.join(os.path.dirname(stmt['path']), "extracted")
            
            # Export to JSON
            json_path = os.path.join(output_dir, f"{os.path.splitext(stmt['name'])[0]}.json")
            export_to_json(result, json_path)
            
            # Export to CSV
            export_to_csv(result, output_dir)
            
        except Exception as e:
            print(f"ERROR: {e}")
            import traceback
            traceback.print_exc()
    
    print("\n" + "=" * 80)
    print("Extraction complete!")


if __name__ == "__main__":
    main()
