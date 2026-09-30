// Thin client for DataForSEO's task-based APIs (verified directly against
// https://docs.dataforseo.com/v3/keywords_data/google_trends/explore/ while
// building this -- task_post takes an array of task objects and returns a
// task id per task; results aren't ready synchronously, so task_get must be
// polled until it stops returning the "not ready yet" status codes.
const DFS_API_BASE = 'https://api.dataforseo.com/v3';

// 40601 "task handed" / 40602 "task in queue" mean processing hasn't
// finished -- keep polling. Any other non-20000 code is a real error.
const NOT_READY_CODES = new Set([40601, 40602]);

// Carries the DataForSEO status code/message as structured fields (not just
// baked into the message string) so callers can log/store them separately,
// per the requirement to "log the DataForSEO status code and message" on
// failure.
class DataForSeoError extends Error {
  constructor(message, statusCode, statusMessage) {
    super(message);
    this.name = 'DataForSeoError';
    this.statusCode = statusCode ?? null;
    this.statusMessage = statusMessage ?? null;
  }
}

function authHeader() {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) return null;
  return 'Basic ' + Buffer.from(`${login}:${password}`).toString('base64');
}

// Posts one or more tasks in a single call (DataForSEO accepts an array),
// returning the tasks array as-is -- each entry has its own `id` and
// `status_code` (20100 "Task Created" on success, or an error code).
async function postTasks(tasks) {
  const auth = authHeader();
  if (!auth) throw new Error('DATAFORSEO_LOGIN/DATAFORSEO_PASSWORD not set');

  const res = await fetch(`${DFS_API_BASE}/keywords_data/google_trends/explore/task_post`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(tasks)
  });
  if (!res.ok) throw new DataForSeoError(`DataForSEO task_post HTTP ${res.status}: ${await res.text()}`, res.status);
  const data = await res.json();
  if (data.status_code !== 20000) {
    throw new DataForSeoError(`DataForSEO task_post failed: ${data.status_code} ${data.status_message}`, data.status_code, data.status_message);
  }
  return data.tasks;
}

async function getTask(id) {
  const auth = authHeader();
  if (!auth) throw new Error('DATAFORSEO_LOGIN/DATAFORSEO_PASSWORD not set');

  const res = await fetch(`${DFS_API_BASE}/keywords_data/google_trends/explore/task_get/${id}`, {
    headers: { Authorization: auth, 'Content-Type': 'application/json' }
  });
  if (!res.ok) throw new DataForSeoError(`DataForSEO task_get HTTP ${res.status}: ${await res.text()}`, res.status);
  const data = await res.json();
  return data.tasks[0];
}

async function waitForTask(id, { pollMs = 3000, maxWaitMs = 2 * 60 * 1000 } = {}) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const task = await getTask(id);
    if (task.status_code === 20000) return task;
    if (!NOT_READY_CODES.has(task.status_code)) {
      throw new DataForSeoError(`DataForSEO task ${id} failed: ${task.status_code} ${task.status_message}`, task.status_code, task.status_message);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new DataForSeoError(`DataForSEO task ${id} did not complete within ${maxWaitMs}ms`, null, 'timed out waiting for task');
}

// Posts every task, waits for each to complete, and returns them in the
// same order as the input -- callers must not assume task_post's response
// order matches input order (DataForSEO doesn't document that it does), so
// this matches each result back to its task by the id task_post itself
// returned for that array position.
async function runTasks(tasks) {
  const posted = await postTasks(tasks);
  const failed = posted.filter((t) => t.status_code !== 20100);
  if (failed.length > 0) {
    const detail = failed.map((t) => `${t.status_code} ${t.status_message}`).join('; ');
    throw new DataForSeoError(`DataForSEO task_post rejected ${failed.length} task(s): ${detail}`, failed[0].status_code, failed[0].status_message);
  }
  const results = [];
  for (const t of posted) {
    results.push(await waitForTask(t.id));
  }
  return results;
}

module.exports = { postTasks, getTask, waitForTask, runTasks, DataForSeoError };
