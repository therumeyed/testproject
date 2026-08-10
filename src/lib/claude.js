const ANTHROPIC_API_BASE = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

function isConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

async function callClaude({ system, prompt, maxTokens = 4096, model }) {
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
      model: model || MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`Anthropic call failed: ${res.status} ${body}`);
    // 429 covers both short-lived rate limiting AND hard usage/spend limits
    // (e.g. "usage limit exceeded") -- neither recovers by immediately
    // retrying the same request, unlike a malformed-JSON response. Callers
    // use this to stop outright instead of retrying/splitting into more
    // doomed requests against an already-exhausted limit.
    err.isRateLimit = res.status === 429;
    throw err;
  }
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
async function callClaudeJson({ system, prompt, maxTokens = 4096, validate, maxRetries = 2, model }) {
  let lastError;
  let currentPrompt = prompt;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const text = await callClaude({ system, prompt: currentPrompt, maxTokens, model });
      const parsed = extractJson(text);
      if (validate) {
        const validationError = validate(parsed);
        if (validationError) throw new Error(`Schema validation failed: ${validationError}`);
      }
      return parsed;
    } catch (err) {
      if (err.isRateLimit) throw err; // don't retry into an already-exhausted limit
      lastError = err;
      currentPrompt = `${prompt}\n\nYour previous response was invalid: ${err.message}\nReturn ONLY valid JSON matching the required schema, no other text.`;
    }
  }
  throw lastError;
}

module.exports = { callClaude, callClaudeJson, isConfigured, MODEL };
