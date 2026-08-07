const APIFY_API_BASE = 'https://api.apify.com/v2';

// Apify actor IDs are "author/name" but the REST API path wants "author~name".
async function runActor(actorId, input) {
  const token = process.env.APIFY_TOKEN;
  const encodedActorId = actorId.replace('/', '~');
  const url = `${APIFY_API_BASE}/acts/${encodedActorId}/run-sync-get-dataset-items?token=${token}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  });
  if (!res.ok) throw new Error(`Apify actor ${actorId} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

module.exports = { runActor };
