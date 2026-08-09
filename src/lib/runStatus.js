// In-memory progress tracker for a manually-triggered ingest run (Admin ->
// "Run collection now"). Single process, single concurrent run -- good
// enough for this tool's scale, and much simpler than a real job queue.
// Not used to track the scheduled cron run (that's a separate, short-lived
// process with no UI to poll it from); this is purely for the interactive
// admin-triggered run so a person watching the page can see it's alive.
const STAGES = [
  { key: 'tiktok', label: 'Collecting TikTok' },
  { key: 'instagram', label: 'Collecting Instagram' },
  { key: 'reddit', label: 'Collecting Reddit' },
  { key: 'clustering', label: 'Clustering into trends (Claude)' },
  { key: 'google_trends', label: 'Validating against Google Trends' },
  { key: 'scoring', label: 'Calculating scores' },
  { key: 'recommendations', label: 'Generating recommendations (Claude)' }
];

const state = {
  running: false,
  startedAt: null,
  finishedAt: null,
  error: null,
  stageKey: null,
  current: 0,
  total: 0,
  detail: '',
  log: []
};

function startRun() {
  state.running = true;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.error = null;
  state.stageKey = null;
  state.current = 0;
  state.total = 0;
  state.detail = '';
  state.log = [];
}

function setStage(stageKey, total = 0) {
  state.stageKey = stageKey;
  state.current = 0;
  state.total = total;
  state.detail = '';
  const label = STAGES.find((s) => s.key === stageKey)?.label || stageKey;
  pushLog(`${label}${total ? ` -- ${total} item(s)` : ''}`);
}

function tick(detail, by = 1) {
  state.current += by;
  if (detail) state.detail = detail;
}

function pushLog(line) {
  state.log.push({ t: new Date().toISOString(), line: String(line).slice(0, 300) });
  if (state.log.length > 60) state.log.shift();
}

function finishRun(err) {
  state.running = false;
  state.finishedAt = new Date().toISOString();
  state.error = err ? String(err.message || err) : null;
  pushLog(err ? `Run failed: ${state.error}` : 'Run complete.');
}

function getStatus() {
  const stageIndex = STAGES.findIndex((s) => s.key === state.stageKey);
  return {
    ...state,
    log: [...state.log].reverse(), // newest first for the UI
    stageIndex,
    stageCount: STAGES.length,
    stageLabel: STAGES.find((s) => s.key === state.stageKey)?.label || null
  };
}

module.exports = { startRun, setStage, tick, pushLog, finishRun, getStatus, STAGES };
