const ANTHROPIC_API_BASE = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

function isConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

async function callClaude({ system, prompt, maxTokens = 4096 }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const res = await fetch(ANTHROPIC_API_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!res.ok) throw new Error(`Anthropic call failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.content?.[0]?.text || '';
}

function extractJson(text) {
  const arrayMatch = text.match(/\[[\s\S]*\]/);
  const objectMatch = text.match(/\{[\s\S]*\}/);
  const candidate = arrayMatch && (!objectMatch || arrayMatch.index <= objectMatch.index)
    ? arrayMatch[0]
    : (objectMatch ? objectMatch[0] : text);
  return JSON.parse(candidate);
}

// Calls Claude and requires the response to (a) parse as JSON and (b) pass
// the caller's validate() function. Retries with the validation error fed
// back to the model rather than silently accepting malformed output --
// required by section 13 ("Reject or retry invalid JSON").
async function callClaudeJson({ system, prompt, maxTokens = 4096, validate, maxRetries = 2 }) {
  let lastError;
  let currentPrompt = prompt;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const text = await callClaude({ system, prompt: currentPrompt, maxTokens });
      const parsed = extractJson(text);
      if (validate) {
        const validationError = validate(parsed);
        if (validationError) throw new Error(`Schema validation failed: ${validationError}`);
      }
      return parsed;
    } catch (err) {
      lastError = err;
      currentPrompt = `${prompt}\n\nYour previous response was invalid: ${err.message}\nReturn ONLY valid JSON matching the required schema, no other text.`;
    }
  }
  throw lastError;
}

module.exports = { callClaude, callClaudeJson, isConfigured, MODEL };
