import json
import re

# Load the proposals
with open('data/proposals.json', 'r', encoding='utf-8') as f:
    proposals = json.load(f)

# Get the first proposal with banking documents
proposal = proposals[0]
proposal_id = proposal.get('id')

print(f"Proposal ID: {proposal_id}")
print(f"Applicant: {proposal.get('applicantName')}")

# Get banking documents
banking_docs = [d for d in proposal.get('documents', []) if d.get('category') == 'banking']
print(f"\nBanking documents: {len(banking_docs)}")

# Combine all bank statement text
all_bank_text = ''
for doc in banking_docs:
    text = doc.get('extractedText', '') or ''
    all_bank_text += text.lower() + '\n'

print(f"Total bank statement text length: {len(all_bank_text)}")

# Print first 20 lines to see actual format
print("\nFirst 30 lines of bank statement:")
lines = all_bank_text.split('\n')
for line in lines[:30]:
    if line.strip():
        print(f"  {line[:120]}")

# Find lines containing ACH/EMI keywords
print("\n\nLines with ACH/EMI keywords:")
for line in lines:
    if 'ach d-' in line or 'fedbank' in line or 'stan chart' in line or 'tatacap' in line:
        print(f"  {line[:150]}")

