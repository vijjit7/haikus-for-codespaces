import json
import re

# Load the proposals
with open('data/proposals.json', 'r', encoding='utf-8') as f:
    proposals = json.load(f)

# Sample EMI amounts to search (based on typical loan EMIs)
test_emis = [73718, 185881, 50000, 25000, 15000]

# Check first proposal's banking documents for EMI patterns
for proposal in proposals[:1]:
    if 'documents' in proposal:
        for doc in proposal['documents']:
            if doc.get('category') == 'banking':
                text = doc.get('extractedText', '') or ''
                if len(text) > 0:
                    print(f"File: {doc.get('originalName', 'Unknown')}")
                    print(f"Text length: {len(text)}")
                    
                    # Search for ACH/EMI patterns
                    text_lower = text.lower()
                    
                    # Find all ACH debit transactions
                    ach_pattern = r'ach d-[^\n]+'
                    ach_matches = re.findall(ach_pattern, text_lower)
                    print(f"ACH transactions found: {len(ach_matches)}")
                    for m in ach_matches[:5]:
                        print(f"  - {m[:100]}")
                    
                    # Search for specific EMI amounts
                    print("\nSearching for EMI amounts:")
                    for emi in test_emis:
                        emi_str = str(emi)
                        emi_formatted = f"{emi:,}"  # 73,718
                        emi_with_decimal = f"{emi_formatted}.00"  # 73,718.00
                        
                        found = emi_str in text_lower or emi_formatted.lower() in text_lower or emi_with_decimal.lower() in text_lower
                        print(f"  EMI {emi}: {'FOUND' if found else 'NOT FOUND'} (searching for {emi_str}, {emi_formatted}, {emi_with_decimal})")
                    
                    print('---\n')

