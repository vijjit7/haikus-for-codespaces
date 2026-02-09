import sys
import json
import anthropic
import os

def ask_claude(prompt, model="claude-opus-4-20250514", max_tokens=1024):
    client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))
    message = client.messages.create(
        model=model,
        max_tokens=max_tokens,
        messages=[
            {"role": "user", "content": prompt}
        ]
    )
    return "".join([block.text for block in message.content])

if __name__ == "__main__":
    # Read prompt from stdin (JSON)
    input_data = sys.stdin.read()
    data = json.loads(input_data)
    prompt = data.get("prompt", "")
    
    if not prompt:
        print("Error: No prompt provided", file=sys.stderr)
        sys.exit(1)
    
    result = ask_claude(prompt)
    print(result)
