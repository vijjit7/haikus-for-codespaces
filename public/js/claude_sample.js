// Sample frontend call to Claude API endpoint
async function askClaude(prompt) {
  const response = await fetch('/api/claude', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt })
  });
  const data = await response.json();
  if (data.success) {
    return data.response;
  } else {
    throw new Error(data.error || 'Claude API error');
  }
}

// Example usage:
askClaude('Write a haiku about coding.')
  .then(result => console.log('Claude says:', result))
  .catch(err => console.error('Error:', err));
