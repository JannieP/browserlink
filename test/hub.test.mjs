import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHub, waitFor } from './helpers.mjs';
import { connectPeer, defaultRespond, SKIP } from './peer.mjs';

test('health responds and /mcp requires the bearer token', async (t) => {
  const hub = await startHub();
  t.after(() => hub.stop());

  const health = await fetch(hub.base + '/health');
  assert.equal(health.status, 200);

  const noAuth = await fetch(hub.base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noAuth.status, 401);

  const list = await hub.mcp('tools/list');
  assert.equal(list.status, 200);
  const names = list.json.result.tools.map(x => x.name);
  for (const want of ['navigate', 'snapshot', 'click', 'file_upload', 'handle_dialog', 'activity']) {
    assert.ok(names.includes(want), `missing tool ${want}`);
  }
});

test('an oversized request body is rejected and the hub stays up', async (t) => {
  const hub = await startHub();
  t.after(() => hub.stop());

  const r = await fetch(hub.base + '/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${hub.token}`, 'content-type': 'application/json' },
    body: 'x'.repeat(5 * 1024 * 1024),
  });
  assert.equal(r.status, 413);
  assert.equal((await fetch(hub.base + '/health')).status, 200);
});

test('malformed WebSocket messages do not crash the hub', async (t) => {
  const hub = await startHub();
  t.after(() => hub.stop());

  const peer = connectPeer(hub, { hello: false });
  await peer.ready;
  peer.ws.send('not json at all');
  peer.ws.send(JSON.stringify(null));
  peer.ws.send(JSON.stringify({ type: 'hello' })); // missing instanceId
  peer.ws.send(JSON.stringify({ type: 'result', id: 42 })); // no session yet
  await new Promise(r => setTimeout(r, 150));

  assert.equal((await fetch(hub.base + '/health')).status, 200);
  await peer.close();
});

test('a session registers and a tool call round-trips to the peer', async (t) => {
  const hub = await startHub();
  t.after(() => hub.stop());

  const peer = connectPeer(hub, { name: 'work' });
  await peer.ready;
  await waitFor(async () => (await hub.callTool('list_sessions')).text.includes('work'));

  const r = await hub.callTool('get_text', { tab: 'work:1' });
  assert.equal(r.isError, false);
  assert.ok(r.text.includes('hello world'), r.text);
  assert.ok(peer.calls.some(c => c.method === 'text'));
});

test('reconnecting the same instance rejects the old pending call promptly', async (t) => {
  const hub = await startHub();
  t.after(() => hub.stop());

  const respondHang = (m, p) => (m === 'text' ? SKIP : defaultRespond(m, p));
  const peerA = connectPeer(hub, { name: 'work', instanceId: 'dup', respond: respondHang });
  await peerA.ready;
  await waitFor(async () => (await hub.callTool('list_sessions')).text.includes('work'));

  const pending = hub.callTool('get_text', { tab: 'work:1' }); // peerA never replies to 'text'
  await new Promise(r => setTimeout(r, 150));

  const started = Date.now();
  const peerB = connectPeer(hub, { name: 'work', instanceId: 'dup' });
  await peerB.ready;

  const r = await pending;
  assert.ok(Date.now() - started < 5000, 'old pending call should reject well before the 30s timeout');
  assert.equal(r.isError, true);
  assert.match(r.text, /replaced|completion is unknown|not connected/i);
});

test('a bare tab id present in two sessions is rejected as ambiguous', async (t) => {
  const hub = await startHub();
  t.after(() => hub.stop());

  const a = connectPeer(hub, { name: 'alpha', instanceId: 'a' });
  const b = connectPeer(hub, { name: 'beta', instanceId: 'b' });
  await a.ready; await b.ready;
  await waitFor(async () => {
    const txt = (await hub.callTool('list_sessions')).text;
    return txt.includes('alpha') && txt.includes('beta');
  });

  const r = await hub.callTool('get_text', { tab: '1' }); // both report a tab id 1
  assert.equal(r.isError, true);
  assert.match(r.text, /multiple|exists in|session:tab/i);
});

test('the activity journal records a completed command', async (t) => {
  const hub = await startHub();
  t.after(() => hub.stop());

  const peer = connectPeer(hub, { name: 'work' });
  await peer.ready;
  await waitFor(async () => (await hub.callTool('list_sessions')).text.includes('work'));

  await hub.callTool('get_text', { tab: 'work:1' });
  const activity = await hub.callTool('activity', {});
  assert.match(activity.text, /text\s+completed/);
});
