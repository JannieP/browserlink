// BrowserLink service worker: keeps a WebSocket to the local hub and executes
// commands against this profile's tabs.
const HUB_URL = 'ws://127.0.0.1:47821/ext';
const VERSION = chrome.runtime.getManifest().version;

let ws = null;
let backoff = 1000;
let lastFocusAt = 0;

// ---------- identity ----------

async function identity() {
  const s = await chrome.storage.local.get(['instanceId', 'name']);
  if (!s.instanceId) {
    s.instanceId = crypto.randomUUID().slice(0, 8);
    await chrome.storage.local.set({ instanceId: s.instanceId });
  }
  let email = '';
  try { email = (await chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' })).email || ''; } catch {}
  return { instanceId: s.instanceId, name: s.name || '', email };
}

// ---------- hub connection ----------

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function setBadge(connected) {
  chrome.action.setBadgeText({ text: connected ? '' : 'off' });
  chrome.action.setBadgeBackgroundColor({ color: '#b3261e' });
}

async function connect() {
  if (ws && ws.readyState <= WebSocket.OPEN) return;
  const sock = new WebSocket(HUB_URL);
  ws = sock;
  sock.onopen = async () => {
    backoff = 1000;
    setBadge(true);
    sock.send(JSON.stringify({ type: 'hello', version: VERSION, ua: navigator.userAgent, lastFocusAt, ...(await identity()) }));
  };
  sock.onmessage = e => handle(JSON.parse(e.data));
  sock.onclose = () => {
    if (ws === sock) ws = null;
    setBadge(false);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 15000);
  };
  sock.onerror = () => {};
}

// Traffic every 20s keeps the MV3 service worker alive; the alarm revives it if Chrome killed it anyway.
setInterval(() => send({ type: 'ping' }), 20000);
chrome.alarms.create('browserlink-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.windows.onFocusChanged.addListener(id => {
  if (id === chrome.windows.WINDOW_ID_NONE) return;
  lastFocusAt = Date.now();
  send({ type: 'focus', at: lastFocusAt });
});
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'status') {
    identity().then(id => reply({ ...id, connected: ws?.readyState === WebSocket.OPEN }));
    return true;
  }
  if (msg?.type === 'setName') {
    chrome.storage.local.set({ name: msg.name }).then(() => { ws?.close(); reply({ ok: true }); });
    return true;
  }
});
connect();

async function handle(msg) {
  if (msg.type !== 'call') return;
  try {
    const fn = commands[msg.method];
    if (!fn) throw new Error('unknown method ' + msg.method);
    send({ type: 'result', id: msg.id, result: await fn(msg.params || {}) });
  } catch (e) {
    send({ type: 'result', id: msg.id, error: String(e?.message || e) });
  }
}

// ---------- helpers ----------

const sleep = ms => new Promise(r => setTimeout(r, ms));

function tabInfo(t) {
  return { id: t.id, windowId: t.windowId, active: t.active, title: t.title, url: t.url, status: t.status,
    incognito: t.incognito, pinned: t.pinned, audible: t.audible };
}

async function waitForLoad(tabId, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  await sleep(150);
  while (Date.now() < end) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === 'complete') return t;
    await sleep(150);
  }
  return chrome.tabs.get(tabId);
}

function restricted(url = '') {
  return /^(chrome|edge|about|devtools|chrome-extension|view-source):/.test(url) || url.startsWith('https://chromewebstore.google.com');
}

async function ensureAgent(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (restricted(tab.url)) throw new Error(`Chrome does not let extensions script ${tab.url}`);
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] }).catch(e => {
    throw new Error('cannot access this page: ' + e.message);
  });
}

// Run a content-script op. frameId undefined => all frames (snapshot); otherwise that frame.
async function runOp(tabId, op, args, frameId = 0) {
  await ensureAgent(tabId);
  const target = frameId === 'all' ? { tabId, allFrames: true } : { tabId, frameIds: [frameId] };
  const res = await chrome.scripting.executeScript({
    target,
    func: async (op, args) => {
      try { return { ok: true, value: await window.__browserlink.run(op, args) }; }
      catch (e) { return { ok: false, error: String(e?.message || e) }; }
    },
    args: [op, args],
  });
  return res.map(r => ({ frameId: r.frameId, ...(r.result || { ok: false, error: 'no result' }) }));
}

async function runOne(tabId, op, args, frameId = 0) {
  const [r] = await runOp(tabId, op, args, frameId);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

// refs are "e12" (top frame) or "f5:e12" (frame 5)
function splitRef(ref) {
  const m = /^(?:f(\d+):)?(e\d+)$/.exec(ref || '');
  if (!m) return null;
  return { frameId: m[1] ? +m[1] : 0, ref: m[2] };
}

function targetArgs(p) {
  if (p.ref) {
    const s = splitRef(p.ref);
    if (!s) throw new Error(`bad ref "${p.ref}" (expected e12 or f5:e12)`);
    return { frameId: s.frameId, args: { ref: s.ref } };
  }
  return { frameId: p.frameId ?? 0, args: { selector: p.selector, text: p.text } };
}

async function pageState(tabId) {
  const t = await chrome.tabs.get(tabId);
  return `${t.title} — ${t.url}`;
}

// After an action that may navigate, give the page a moment and wait out any load it triggered.
async function settle(tabId) {
  await sleep(250);
  const t = await chrome.tabs.get(tabId);
  if (t.status === 'loading') await waitForLoad(tabId, 10000);
}

// ---------- chrome.debugger (trusted input, background screenshots, eval fallback) ----------

const attached = new Map(); // tabId -> detach timer

async function cdp(tabId, method, params = {}) {
  if (!attached.has(tabId)) {
    await chrome.debugger.attach({ tabId }, '1.3');
  } else clearTimeout(attached.get(tabId));
  // Detach after a short idle so Chrome's "started debugging" bar disappears again.
  attached.set(tabId, setTimeout(() => { chrome.debugger.detach({ tabId }).catch(() => {}); attached.delete(tabId); }, 8000));
  return chrome.debugger.sendCommand({ tabId }, method, params);
}
chrome.debugger.onDetach.addListener(src => { clearTimeout(attached.get(src.tabId)); attached.delete(src.tabId); });

async function trustedClick(tabId, p) {
  const { frameId, args } = targetArgs(p);
  if (frameId !== 0) throw new Error('trusted clicks only work in the top frame');
  const pt = await runOne(tabId, 'point', args);
  const button = p.button || 'left';
  const clickCount = p.double ? 2 : 1;
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
  for (let c = 1; c <= clickCount; c++) {
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button, clickCount: c });
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button, clickCount: c });
  }
  return pt.desc;
}

const CDP_KEYS = { Enter: [13, '\r'], Tab: [9, ''], Escape: [27, ''], Backspace: [8, ''], Delete: [46, ''],
  ArrowUp: [38, ''], ArrowDown: [40, ''], ArrowLeft: [37, ''], ArrowRight: [39, ''], Home: [36, ''], End: [35, ''],
  PageUp: [33, ''], PageDown: [34, ''], ' ': [32, ' '] };

async function trustedKey(tabId, key) {
  const parts = key.split('+');
  const k = parts.pop();
  const modifiers = (parts.includes('Alt') ? 1 : 0) | (parts.includes('Control') ? 2 : 0) | (parts.includes('Meta') ? 4 : 0) | (parts.includes('Shift') ? 8 : 0);
  const [code, text] = CDP_KEYS[k] || [k.toUpperCase().charCodeAt(0), modifiers & 6 ? '' : k];
  const base = { key: k, windowsVirtualKeyCode: code, modifiers };
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', text, ...base });
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

// ---------- commands ----------

async function captureScreenshot(tabId, { fullPage = false, maxWidth = 1400 } = {}) {
  const tab = await chrome.tabs.get(tabId);
  let dataUrl;
  if (!fullPage && tab.active) {
    try { dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }); } catch {}
  }
  if (!dataUrl) {
    const r = await cdp(tabId, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage });
    dataUrl = 'data:image/png;base64,' + r.data;
  }
  // Downscale retina captures and re-encode as JPEG to keep the payload small.
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, maxWidth / bmp.width);
  const canvas = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
  const bytes = new Uint8Array(await out.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { mimeType: 'image/jpeg', data: btoa(bin), width: canvas.width, height: canvas.height };
}

function wrapCode(code) {
  const body = /\breturn\b/.test(code) ? code : `return (${code});`;
  return `(async () => { const __r = await (async () => { ${body} })();
    if (__r === undefined) return 'undefined';
    try { return JSON.stringify(__r, null, 2); } catch { return String(__r); } })()`;
}

async function evaluate(tabId, { code, frameId = 0 }) {
  const tab = await chrome.tabs.get(tabId);
  if (restricted(tab.url)) throw new Error(`Chrome does not let extensions script ${tab.url}`);
  const wrapped = wrapCode(code);
  // Preferred: userScripts.execute runs arbitrary code in the page without the debugger bar.
  if (chrome.userScripts?.execute) {
    try {
      const [r] = await chrome.userScripts.execute({ target: { tabId, frameIds: [frameId] }, world: 'MAIN', js: [{ code: wrapped }] });
      if (r.error) throw Object.assign(new Error(r.error), { page: true });
      return r.result;
    } catch (e) {
      if (e.page) throw e;
      // userScripts not enabled for this extension — fall through to the debugger.
    }
  }
  if (frameId !== 0) throw new Error('evaluate in sub-frames needs "Allow User Scripts" enabled for BrowserLink');
  const r = await cdp(tabId, 'Runtime.evaluate', { expression: wrapped, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

const commands = {
  async tabs() {
    const [tabs, wins] = await Promise.all([chrome.tabs.query({}), chrome.windows.getAll()]);
    const focused = wins.find(w => w.focused)?.id;
    return { tabs: tabs.map(tabInfo), focusedWindowId: focused ?? null, lastFocusAt };
  },

  async open({ url = 'about:blank', background = false, newWindow = false }) {
    let tab;
    if (newWindow) {
      const w = await chrome.windows.create({ url, focused: !background });
      tab = w.tabs[0];
    } else tab = await chrome.tabs.create({ url, active: !background });
    return tabInfo(url === 'about:blank' ? tab : await waitForLoad(tab.id));
  },

  async close({ tabId }) {
    await chrome.tabs.remove(tabId);
    return 'closed';
  },

  async activate({ tabId }) {
    const t = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(t.windowId, { focused: true });
    return tabInfo(t);
  },

  async navigate({ tabId, url, action }) {
    if (action === 'back') await chrome.tabs.goBack(tabId);
    else if (action === 'forward') await chrome.tabs.goForward(tabId);
    else if (action === 'reload') await chrome.tabs.reload(tabId);
    else await chrome.tabs.update(tabId, { url });
    return tabInfo(await waitForLoad(tabId));
  },

  async snapshot({ tabId, selector, interactiveOnly, maxChars = 30000 }) {
    const results = await runOp(tabId, 'snapshot', { selector, interactiveOnly, maxChars }, selector ? 0 : 'all');
    const parts = [];
    for (const r of results.sort((a, b) => a.frameId - b.frameId)) {
      if (!r.ok) { if (r.frameId === 0) throw new Error(r.error); continue; }
      if (r.frameId === 0) { parts.unshift(r.value); continue; }
      const body = r.value.split('\n').slice(2).join('\n').trim();
      if (!body) continue;
      // Prefix child-frame refs so actions route back to the right frame.
      const url = r.value.split('\n')[1].slice(5);
      parts.push(`--- frame f${r.frameId} (${url}) ---\n` + body.replace(/\[(e\d+)\]/g, `[f${r.frameId}:$1]`));
    }
    return parts.join('\n\n');
  },

  async click({ tabId, trusted, double, button, ...p }) {
    const desc = trusted ? await trustedClick(tabId, { ...p, double, button })
      : await runOne(tabId, 'click', { ...targetArgs(p).args, double, button }, targetArgs(p).frameId);
    await settle(tabId);
    return `clicked ${desc}\npage: ${await pageState(tabId)}`;
  },

  async type({ tabId, value, clear = true, submit = false, trusted, ...p }) {
    const { frameId, args } = targetArgs(p);
    let desc;
    if (trusted) {
      desc = await runOne(tabId, 'focus', { ...args, clear }, frameId);
      await cdp(tabId, 'Input.insertText', { text: value });
      if (submit) await trustedKey(tabId, 'Enter');
    } else desc = await runOne(tabId, 'type', { ...args, value, clear, submit }, frameId);
    await settle(tabId);
    return `typed into ${desc}\npage: ${await pageState(tabId)}`;
  },

  async press({ tabId, key, trusted, ...p }) {
    let out;
    if (trusted) {
      if (p.ref || p.selector || p.text) { const { frameId, args } = targetArgs(p); await runOne(tabId, 'focus', args, frameId); }
      await trustedKey(tabId, key);
      out = `pressed ${key}`;
    } else {
      const { frameId, args } = p.ref || p.selector || p.text ? targetArgs(p) : { frameId: 0, args: {} };
      out = await runOne(tabId, 'press', { ...args, key }, frameId);
    }
    await settle(tabId);
    return `${out}\npage: ${await pageState(tabId)}`;
  },

  async select({ tabId, values, ...p }) {
    const { frameId, args } = targetArgs(p);
    return runOne(tabId, 'select', { ...args, values }, frameId);
  },

  async hover({ tabId, ...p }) {
    const { frameId, args } = targetArgs(p);
    return 'hovered ' + await runOne(tabId, 'hover', args, frameId);
  },

  async scroll({ tabId, direction, amount, ...p }) {
    const hasTarget = p.ref || p.selector || p.text;
    const { frameId, args } = hasTarget ? targetArgs(p) : { frameId: 0, args: null };
    return runOne(tabId, 'scroll', { target: args, direction, amount }, frameId);
  },

  async text({ tabId, selector, maxChars }) {
    return runOne(tabId, 'text', { selector, maxChars });
  },

  async waitFor({ tabId, text, selector, gone, timeoutMs = 10000 }) {
    const ok = await runOne(tabId, 'waitFor', { text, selector, gone, timeoutMs });
    const what = selector ? `selector ${selector}` : `text "${text}"`;
    if (!ok) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what} to ${gone ? 'disappear' : 'appear'}`);
    return `${what} ${gone ? 'gone' : 'present'}`;
  },

  screenshot({ tabId, fullPage }) {
    return captureScreenshot(tabId, { fullPage });
  },

  evaluate({ tabId, code, frameId }) {
    return evaluate(tabId, { code, frameId });
  },

  async console({ tabId, clear = false }) {
    const res = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true }, world: 'MAIN',
      func: clear => window.__browserlinkCapture?.read(clear) || [], args: [clear],
    });
    return res.flatMap(r => r.result || []).sort((a, b) => a.t - b.t);
  },

  async network({ tabId }) {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN',
      func: () => performance.getEntriesByType('resource').map(e => ({
        url: e.name, type: e.initiatorType, status: e.responseStatus || null,
        ms: Math.round(e.duration), bytes: e.transferSize, start: Math.round(e.startTime),
      })),
    });
    return r.result;
  },

  async setName({ name }) {
    await chrome.storage.local.set({ name });
    return identity();
  },
};
