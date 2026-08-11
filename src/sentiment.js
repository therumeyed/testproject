const ANTHROPIC_API_BASE = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const BATCH_SIZE = 20;

function buildPrompt(mentions) {
  const numbered = mentions
    .map((m, i) => `${i}. [${m.source}] ${m.title ? m.title + ' -- ' : ''}${(m.snippet || '').slice(0, 400)}`)
    .join('\n');

  return `You are screening and classifying items that came up in a search for "Melbourne Airport" (Melbourne, Victoria, Australia -- MEL) for the airport's operations team. They just introduced a change requiring a roughly 5-minute walk between the pickup/drop-off area and the terminal, and want to catch real customer dissatisfaction about this and related issues (pricing, signage, shuttle service, staff, accessibility, wait times).

IMPORTANT -- these are search results, not guaranteed matches. Some are false positives: they may be about a *different* place also called Melbourne (e.g. Melbourne, Florida, USA and its own unrelated "Melbourne Airport"/MLB), about a *different* airport entirely that happened to appear in the same search or post (e.g. Sydney Airport), or otherwise have no real connection to Melbourne Airport, Australia even though the search returned them. Judge this ONLY from the text given below -- never assume something is genuinely about Melbourne Airport, Australia just because it showed up in this search.

For each numbered item, return:
- "relevant": true only if the text itself clearly concerns Melbourne Airport, Melbourne/Victoria/Australia, or one of its car park products -- false if it's about a different place/airport, or the text gives no real indication either way
- "sentiment": "negative", "neutral", or "positive" -- classify by actual meaning and tone, not just keyword matching (e.g. "kind of a hassle now" or "wasn't expecting that walk with all our bags" is negative even with no explicit negative word). If "relevant" is false, just use "neutral".
- "severity": only for relevant negative items -- "low" (mild dissatisfaction/minor gripe), "medium" (clear complaint), or "high" (strong anger, safety concern, explicit refund/legal/media-escalation threat, or a severe operational failure). null otherwise.
- "reason": one short sentence. If "relevant" is false, explain why (e.g. "refers to Melbourne, Florida's airport" or "post is about Sydney Airport, no Melbourne connection in the text"). Otherwise explain the sentiment classification.

Items:
${numbered}

Respond with ONLY a JSON array, same order as the items. No other text.`;
}

async function classifyBatch(mentions) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || mentions.length === 0) return [];

  const res = await fetch(ANTHROPIC_API_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content: buildPrompt(mentions) }]
    })
  });
  if (!res.ok) throw new Error(`Anthropic classify failed: ${res.status} ${await res.text()}`);

  const data = await res.json();
  const text = data.content?.[0]?.text || '[]';
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);

  return mentions.map((m, i) => ({
    id: m.id,
    relevant: parsed[i]?.relevant !== false, // default true if the model omitted it
    sentiment: parsed[i]?.sentiment || null,
    severity: parsed[i]?.severity || null,
    reason: parsed[i]?.reason || null
  }));
}

// Chunked so one bad/oversized batch can't take down classification for
// everything else in the run -- mirrors the per-source error isolation
// already used in ingest.js.
async function classifyMentions(mentions) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('[sentiment] skipped: ANTHROPIC_API_KEY not set');
    return [];
  }
  if (mentions.length === 0) return [];

  const results = [];
  for (let i = 0; i < mentions.length; i += BATCH_SIZE) {
    const chunk = mentions.slice(i, i + BATCH_SIZE);
    try {
      results.push(...(await classifyBatch(chunk)));
    } catch (err) {
      console.error(`[sentiment] batch ${i / BATCH_SIZE + 1} failed:`, err.message);
    }
  }
  return results;
}

module.exports = { classifyMentions };
