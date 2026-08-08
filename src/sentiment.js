const ANTHROPIC_API_BASE = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const BATCH_SIZE = 20;

function buildPrompt(mentions) {
  const numbered = mentions
    .map((m, i) => `${i}. [${m.source}] ${m.title ? m.title + ' -- ' : ''}${(m.snippet || '').slice(0, 400)}`)
    .join('\n');

  return `You are classifying public mentions of Melbourne Airport's parking and pickup/drop-off services for the airport's operations team. They just introduced a change requiring a roughly 5-minute walk between the pickup/drop-off area and the terminal, and want to catch real customer dissatisfaction about this and related issues (pricing, signage, shuttle service, staff, accessibility, wait times).

For each numbered item, classify by actual meaning and tone, not just keyword matching -- for example "kind of a hassle now" or "wasn't expecting that walk with all our bags" is negative even though it uses no explicit negative word like "bad" or "terrible".

Return a JSON array, same order as the items, one object each with:
- "sentiment": "negative", "neutral", or "positive"
- "severity": only for negative items -- "low" (mild dissatisfaction/minor gripe), "medium" (clear complaint), or "high" (strong anger, safety concern, explicit refund/legal/media-escalation threat, or a severe operational failure). null for neutral/positive items.
- "reason": one short sentence explaining the classification

Items:
${numbered}

Respond with ONLY the JSON array. No other text.`;
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
