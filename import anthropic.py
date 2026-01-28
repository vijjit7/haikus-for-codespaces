import anthropic

client = anthropic.Anthropic(api_key="YOUR_API_KEY")

def ask_claude(prompt, model="claude-opus-4-20250514", max_tokens=1024):
    message = client.messages.create(
        model=model,
        max_tokens=max_tokens,
        messages=[
            {"role": "user", "content": prompt}
        ]
    )
    # message.content is a list of TextBlock, join their text
    return "".join([block.text for block in message.content])