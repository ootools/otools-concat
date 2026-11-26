import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/host/service.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText + '\n//# sourceURL=concat-service-client.js';
const { ConcatdClient, createReadyClient } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

function connection(dispose = async () => {}) {
  return { origin: 'http://127.0.0.1:43210', token: 'session-token', dispose };
}

// Node's native fetch accepts arbitrary receivers; WebKit does not. Enforce its contract.
test('default transport calls Window.fetch with its global receiver for status and project reads', async () => {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = function (url, options) {
    assert.equal(this, globalThis, 'WebKit rejects Window.fetch called with the client as receiver');
    assert.equal(options.headers.Authorization, 'Bearer session-token');
    requests.push(new URL(url));
    return Promise.resolve(Response.json({ ok: true }));
  };
  try {
    const client = new ConcatdClient(connection());
    assert.deepEqual(await client.status(), { ok: true });
    assert.deepEqual(await client.readProject('/测试 project.concatproj'), { ok: true });
    assert.equal(requests[0].href, 'http://127.0.0.1:43210/api/status');
    assert.equal(requests[1].pathname, '/api/project');
    assert.equal(requests[1].searchParams.get('path'), '/测试 project.concatproj');
  } finally {
    globalThis.fetch = original;
  }
});

test('failed health check disposes its sidecar instead of leaving an importable client', async () => {
  let disposed = 0;
  await assert.rejects(createReadyClient(connection(async () => { disposed++; }), async () => {
    throw new TypeError('network');
  }), { code: 'network' });
  assert.equal(disposed, 1);
});

test('HTTP health failure also releases its sidecar', async () => {
  let disposed = 0;
  await assert.rejects(createReadyClient(connection(async () => { disposed++; }), async () =>
    Response.json({ error: 'unavailable' }, { status: 503 })), { code: 'media', message: 'unavailable' });
  assert.equal(disposed, 1);
});

test('client stays private until health succeeds and is disposed only when closed', async () => {
  let resolveHealth;
  const health = new Promise((resolve) => { resolveHealth = resolve; });
  let published = false;
  let disposed = 0;
  const pending = createReadyClient(connection(async () => { disposed++; }), async (url) =>
    url.endsWith('/api/status') ? health : Response.json({}));
  void pending.then(() => { published = true; });
  await Promise.resolve();
  assert.equal(published, false);
  assert.equal(disposed, 0);
  resolveHealth(Response.json({ uptimeSeconds: 1 }));
  const client = await pending;
  assert.ok(client instanceof ConcatdClient);
  assert.equal(published, true);
  assert.equal(disposed, 0);
  await client.close();
  assert.equal(disposed, 1);
});
