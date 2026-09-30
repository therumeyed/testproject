const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { postTasks, waitForTask, runTasks } = require('../src/dataForSeoClient');

let originalFetch;
let originalLogin;
let originalPassword;

beforeEach(() => {
  originalFetch = global.fetch;
  originalLogin = process.env.DATAFORSEO_LOGIN;
  originalPassword = process.env.DATAFORSEO_PASSWORD;
  process.env.DATAFORSEO_LOGIN = 'test-login';
  process.env.DATAFORSEO_PASSWORD = 'test-password';
});

afterEach(() => {
  global.fetch = originalFetch;
  if (originalLogin === undefined) delete process.env.DATAFORSEO_LOGIN; else process.env.DATAFORSEO_LOGIN = originalLogin;
  if (originalPassword === undefined) delete process.env.DATAFORSEO_PASSWORD; else process.env.DATAFORSEO_PASSWORD = originalPassword;
});

describe('postTasks', () => {
  test('sends Basic Auth built from login:password', async () => {
    let capturedAuth;
    global.fetch = async (url, opts) => {
      capturedAuth = opts.headers.Authorization;
      return { ok: true, json: async () => ({ status_code: 20000, tasks: [{ id: 't1', status_code: 20100 }] }) };
    };
    await postTasks([{ keywords: ['x'] }]);
    assert.equal(capturedAuth, 'Basic ' + Buffer.from('test-login:test-password').toString('base64'));
  });

  test('throws when credentials are not set', async () => {
    delete process.env.DATAFORSEO_LOGIN;
    await assert.rejects(() => postTasks([{ keywords: ['x'] }]), /DATAFORSEO_LOGIN/);
  });

  test('throws on a top-level API error', async () => {
    global.fetch = async () => ({ ok: true, json: async () => ({ status_code: 40000, status_message: 'bad request' }) });
    await assert.rejects(() => postTasks([{ keywords: ['x'] }]), /40000/);
  });
});

describe('waitForTask', () => {
  test('polls through "task handed"/"task in queue" until status 20000', async () => {
    const responses = [
      { status_code: 40601, status_message: 'Task Handed.' },
      { status_code: 40602, status_message: 'Task In Queue.' },
      { status_code: 20000, status_message: 'Ok.', result: [{ items: [] }] }
    ];
    let call = 0;
    global.fetch = async () => ({ ok: true, json: async () => ({ tasks: [responses[call++]] }) });
    const task = await waitForTask('abc', { pollMs: 1 });
    assert.equal(task.status_code, 20000);
    assert.equal(call, 3);
  });

  test('throws immediately on a real error status instead of continuing to poll', async () => {
    global.fetch = async () => ({ ok: true, json: async () => ({ tasks: [{ status_code: 40501, status_message: 'invalid field' }] }) });
    await assert.rejects(() => waitForTask('abc', { pollMs: 1 }), /40501/);
  });

  test('times out if the task never completes', async () => {
    global.fetch = async () => ({ ok: true, json: async () => ({ tasks: [{ status_code: 40602, status_message: 'Task In Queue.' }] }) });
    await assert.rejects(() => waitForTask('abc', { pollMs: 1, maxWaitMs: 5 }), /did not complete/);
  });
});

describe('runTasks', () => {
  test('posts all tasks, rejects if any is not accepted, and returns completed results in input order', async () => {
    let postCount = 0;
    let getCount = 0;
    global.fetch = async (url) => {
      if (url.includes('task_post')) {
        postCount++;
        return { ok: true, json: async () => ({ status_code: 20000, tasks: [{ id: 'a', status_code: 20100 }, { id: 'b', status_code: 20100 }] }) };
      }
      getCount++;
      const id = url.split('/').pop();
      return { ok: true, json: async () => ({ tasks: [{ id, status_code: 20000, result: [{ marker: id }] }] }) };
    };
    const results = await runTasks([{ keywords: ['a'] }, { keywords: ['b'] }]);
    assert.equal(postCount, 1);
    assert.equal(results.length, 2);
    assert.equal(results[0].id, 'a');
    assert.equal(results[1].id, 'b');
  });

  test('throws immediately if task_post rejects one of the tasks, without polling any of them', async () => {
    global.fetch = async (url) => {
      if (url.includes('task_post')) {
        return { ok: true, json: async () => ({ status_code: 20000, tasks: [{ id: 'a', status_code: 20100 }, { id: 'b', status_code: 40501, status_message: 'bad keyword' }] }) };
      }
      throw new Error('should not poll when a task was rejected');
    };
    await assert.rejects(() => runTasks([{ keywords: ['a'] }, { keywords: ['!!!'] }]), /40501/);
  });
});
