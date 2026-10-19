// A fake BrowserLink extension: a WebSocket peer that speaks the hub's protocol
// so the hub can be tested without Chrome. A responder decides how each command
// is answered; return SKIP to never reply (simulate a hang/lost message).
import { WebSocket } from 'ws';
import crypto from 'node:crypto';

export const SKIP = Symbol('skip');

export function defaultRespond(method, params) {
  if (method === 'tabs') {
    return { tabs: [{ id: 1, windowId: 1, active: true, title: 'Test', url: 'https://example.com/', status: 'complete', incognito: false, pinned: false, audible: false }], focusedWindowId: 1, lastFocusAt: Date.now() };
  }
  if (method === 'text') return 'hello world';
  if (method === 'setName') return { instanceId: 'x', name: params?.name || '', email: '' };
  return 'ok';
}

export function connectPeer(hub, { instanceId = 'inst-' + crypto.randomBytes(3).toString('hex'), name = '', email = '', hello = true, respond = defaultRespond } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/ext`, { headers: { Origin: hub.origin } });
  const calls = [];
  const api = {
    ws, instanceId, name, calls,
    ready: new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); }),
    send(obj) { ws.send(JSON.stringify(obj)); },
    sayHello(extra = {}) { this.send({ type: 'hello', instanceId, name, email, lastFocusAt: Date.now(), ...extra }); },
    close() { return new Promise(r => { ws.on('close', r); try { ws.close(); } catch {} setTimeout(r, 500); }); },
  };
  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type !== 'call') return;
    calls.push(msg);
    Promise.resolve(respond(msg.method, msg.params, msg)).then(result => {
      if (result === SKIP) return;
      if (result && result.__error) api.send({ type: 'result', id: msg.id, error: result.__error });
      else api.send({ type: 'result', id: msg.id, result });
    }).catch(e => api.send({ type: 'result', id: msg.id, error: String(e) }));
  });
  ws.on('open', () => { if (hello) api.sayHello(); });
  return api;
}
