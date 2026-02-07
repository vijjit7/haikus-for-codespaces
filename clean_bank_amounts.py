"""
Bank Statement Amount Cleaning Utility
Normalizes amounts from PDF extraction for consistent EMI matching.
"""

import re
import json


def normalize_amount(amount_str):
    """
    Normalize an amount string to a clean integer/float.
    Handles Indian number format (1,75,759.00), currency symbols, and various formats.
    
    Args:
        amount_str: Amount string like "₹1,75,759.00", "1,75,759", "175759.00", etc.
        
    Returns:
        float: Cleaned amount as number, or None if parsing fails
    """
    if amount_str is None:
        return None
    
    # Convert to string and strip whitespace
    s = str(amount_str).strip()
    
    if not s:
        return None
    
    # Remove currency symbols (₹, $, Rs., INR, etc.)
    s = re.sub(r'[₹$€£]|Rs\.?|INR', '', s, flags=re.IGNORECASE)
    
    # Remove all whitespace and newlines
    s = re.sub(r'\s+', '', s)
    
    # Handle parentheses for negative amounts: (1000) -> -1000
    if s.startswith('(') and s.endswith(')'):
        s = '-' + s[1:-1]
    
    # Remove all commas (handles both Indian 1,75,759 and Western 175,759)
    s = s.replace(',', '')
    
    # Handle trailing minus sign: 1000- -> -1000
    if s.endswith('-'):
        s = '-' + s[:-1]
    
    # Try to convert to float
    try:
        return float(s)
    except ValueError:
        return None


def amount_to_search_variants(amount):
    """
    Generate all possible string representations of an amount for searching.
    
    Args:
        amount: Number or string amount (e.g., 175759 or "1,75,759")
        
    Returns:
        list: All searchable formats ['175759', '1,75,759', '1,75,759.00', '175759.00']
    """
    # First normalize to get clean number
    if isinstance(amount, str):
        num = normalize_amount(amount)
    else:
        num = amount
    
    if num is None:
        return []
    
    # Round to handle floating point issues
    num = round(num, 2)
    int_val = int(num) if num == int(num) else None
    
    variants = set()
    
    # Plain number without formatting
    if int_val is not None:
        variants.add(str(int_val))  # 175759
    variants.add(f"{num:.2f}")  # 175759.00
    
    # Indian format (groups of 2 after first 3 from right)
    if int_val is not None:
        indian_fmt = format_indian(int_val)
        variants.add(indian_fmt)  # 1,75,759
        variants.add(indian_fmt + '.00')  # 1,75,759.00
    
    # Western format (groups of 3)
    if int_val is not None:
        western_fmt = f"{int_val:,}"
        variants.add(western_fmt)  # 175,759
        variants.add(western_fmt + '.00')  # 175,759.00
    
    # With decimal but formatted
    if num != int(num):
        indian_decimal = format_indian(int(num)) + f".{int((num % 1) * 100):02d}"
        variants.add(indian_decimal)
    
    return list(variants)


def format_indian(num):
    """
    Format a number in Indian numbering system (e.g., 175759 -> 1,75,759)
    """
    if num < 0:
        return '-' + format_indian(-num)
    
    s = str(int(num))
    
    if len(s) <= 3:
        return s
    
    # First 3 digits from right, then groups of 2
    result = s[-3:]
    s = s[:-3]
    
    while s:
        result = s[-2:] + ',' + result
        s = s[:-2]
    
    return result


def extract_amounts_from_text(text):
    """
    Extract all amount values from bank statement text.
    
    Args:
        text: Raw text from PDF extraction
        
    Returns:
        list: List of dicts with 'original', 'normalized', 'search_variants'
    """
    amounts = []
    
    # Pattern to match various amount formats
    # Matches: 1,75,759.00, 175759, 1,75,759, ₹175,759.00, etc.
    amount_pattern = r'''
        (?:₹|Rs\.?|INR)?\s*                    # Optional currency
        (?:
            \d{1,3}(?:,\d{2})*(?:,\d{3})?      # Indian format: 1,75,759 or 17,57,590
            |
            \d{1,3}(?:,\d{3})*                  # Western format: 175,759
            |
            \d+                                  # Plain number: 175759
        )
        (?:\.\d{1,2})?                          # Optional decimals
    '''
    
    pattern = re.compile(amount_pattern, re.VERBOSE | re.IGNORECASE)
    
    for match in pattern.finditer(text):
        original = match.group().strip()
        normalized = normalize_amount(original)
        
        if normalized is not None and normalized > 0:
            amounts.append({
                'original': original,
                'normalized': normalized,
                'search_variants': amount_to_search_variants(normalized)
            })
    
    return amounts


def clean_bank_statement_text(text):
    """
    Clean bank statement text for better amount matching.
    Joins split amounts, normalizes whitespace.
    
    Args:
        text: Raw extracted text from PDF
        
    Returns:
        str: Cleaned text with normalized amounts
    """
    # Join amounts that got split across lines (e.g., "1,75,759\n.00" -> "1,75,759.00")
    text = re.sub(r'(\d)\s*\n\s*(\.?\d)', r'\1\2', text)
    
    # Normalize multiple spaces/tabs to single space
    text = re.sub(r'[ \t]+', ' ', text)
    
    # Remove extra newlines (keep max 2)
    text = re.sub(r'\n{3,}', '\n\n', text)
    
    return text


def search_emi_in_text(text, emi_amount, tolerance=1):
    """
    Search for EMI amount in bank statement text with various format matching.
    
    Args:
        text: Bank statement text
        emi_amount: EMI amount to search (number or string)
        tolerance: Allow ±tolerance variation (default 1 rupee)
        
    Returns:
        dict: {found: bool, matches: list of matched strings, count: int}
    """
    # Clean the text first
    cleaned_text = clean_bank_statement_text(text)
    text_lower = cleaned_text.lower()
    
    # Get all search variants
    variants = amount_to_search_variants(emi_amount)
    
    # Add tolerance variants (±1, ±2 rupees for rounding differences)
    base_amount = normalize_amount(emi_amount) if isinstance(emi_amount, str) else emi_amount
    if base_amount and tolerance > 0:
        for t in range(1, tolerance + 1):
            variants.extend(amount_to_search_variants(base_amount + t))
            variants.extend(amount_to_search_variants(base_amount - t))
    
    # Remove duplicates
    variants = list(set(variants))
    
    matches = []
    for variant in variants:
        if variant.lower() in text_lower:
            # Count occurrences (months where EMI was paid)
            count = text_lower.count(variant.lower())
            matches.append({'format': variant, 'count': count})
    
    total_count = sum(m['count'] for m in matches) if matches else 0
    
    return {
        'found': len(matches) > 0,
        'matches': matches,
        'count': total_count,
        'searched_variants': variants
    }


# Test with sample data
if __name__ == '__main__':
    # Test amount normalization
    test_amounts = [
        "₹1,75,759.00",
        "1,75,759",
        "175759",
        "175,759.00",
        "Rs. 1,75,759.00",
        "18,500.00",
        "3,76,942.00"
    ]
    
    print("Amount Normalization Tests:")
    print("-" * 50)
    for amt in test_amounts:
        normalized = normalize_amount(amt)
        variants = amount_to_search_variants(amt)
        print(f"Original: {amt:20} -> Normalized: {normalized}")
        print(f"  Search variants: {variants}")
    
    print("\n" + "=" * 60)
    print("EMI Search Test:")
    print("-" * 50)
    
    # Load proposals and test EMI search
    try:
        with open('data/proposals.json', 'r', encoding='utf-8') as f:
            proposals = json.load(f)
        
        # Get first proposal with banking documents
        proposal = proposals[0] if proposals else None
        
        if proposal:
            banking_docs = [d for d in proposal.get('documents', []) if d.get('category') == 'banking']
            all_bank_text = ' '.join(d.get('extractedText', '') or '' for d in banking_docs)
            
            # Test EMI search for 175759
            emi_to_search = 175759
            result = search_emi_in_text(all_bank_text, emi_to_search)
            
            print(f"\nSearching for EMI: {emi_to_search}")
            print(f"Found: {result['found']}")
            print(f"Total occurrences: {result['count']}")
            print(f"Matched formats: {result['matches']}")
            
            # Also search for other common EMIs
            other_emis = [376942, 208863, 73718, 185881]
            for emi in other_emis:
                result = search_emi_in_text(all_bank_text, emi)
                print(f"\nEMI {emi}: Found={result['found']}, Count={result['count']}")
                
    except FileNotFoundError:
        print("proposals.json not found - skipping live test")
