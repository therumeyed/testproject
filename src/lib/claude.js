const ANTHROPIC_API_BASE = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

function isConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

async function postToAnthropic({ system, prompt, maxTokens, model, temperature, apiKey }) {
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
      // Omitted (undefined) unless a caller opts in -- JSON.stringify drops
      // undefined keys, so this keeps the API default for everyone else.
      ...(temperature === undefined ? {} : { temperature }),
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
    // Some model generations reject `temperature` outright (400,
    // "temperature is deprecated for this model") instead of just ignoring
    // it -- seen live on claude-sonnet-5. Rather than every call site
    // needing to know which models do/don't accept it, flag this so
    // callClaude can transparently retry once without it.
    err.isTemperatureUnsupported = res.status === 400 && temperature !== undefined && /temperature/i.test(body);
    throw err;
  }
  const data = await res.json();
  return { text: data.content?.[0]?.text || '', stopReason: data.stop_reason };
}

async function callClaude({ system, prompt, maxTokens = 4096, model, temperature }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  try {
    return await postToAnthropic({ system, prompt, maxTokens, model, temperature, apiKey });
  } catch (err) {
    if (err.isTemperatureUnsupported) {
      return await postToAnthropic({ system, prompt, maxTokens, model, temperature: undefined, apiKey });
    }
    throw err;
  }
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
async function callClaudeJson({ system, prompt, maxTokens = 4096, validate, maxRetries = 2, model, temperature }) {
  let lastError;
  let currentPrompt = prompt;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let text = '';
    let stopReason;
    try {
      ({ text, stopReason } = await callClaude({ system, prompt: currentPrompt, maxTokens, model, temperature }));
      const parsed = extractJson(text);
      if (validate) {
        const validationError = validate(parsed);
        if (validationError) throw new Error(`Schema validation failed: ${validationError}`);
      }
      return parsed;
    } catch (err) {
      if (err.isRateLimit) throw err; // don't retry into an already-exhausted limit
      // stop_reason tells us definitively whether this was real truncation
      // (max_tokens -- the budget genuinely wasn't enough) or something
      // else entirely (a complete response that still failed to parse/
      // validate, e.g. a formatting slip) -- these need different fixes,
      // and guessing which one happened from the error message alone
      // wasted real time and retries previously.
      const diag = stopReason === 'max_tokens'
        ? `hit max_tokens (cap=${maxTokens}, got ${text.length} chars) -- genuine truncation`
        : `stop_reason=${stopReason || 'unknown'}, response complete (${text.length} chars) but ${err.message}. Tail: ...${text.slice(-120).replace(/\s+/g, ' ')}`;
      lastError = new Error(diag);
      lastError.isRateLimit = false;
      currentPrompt = `${prompt}\n\nYour previous response was invalid: ${err.message}\nReturn ONLY valid JSON matching the required schema, no other text.`;
    }
  }
  throw lastError;
}

module.exports = { callClaude, callClaudeJson, isConfigured, MODEL };
