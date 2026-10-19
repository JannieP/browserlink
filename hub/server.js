// BrowserLink hub: accepts WebSocket connections from the BrowserLink extension
// (one per Chrome profile) and exposes them to Claude Code as an MCP server.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const PORT = Number(process.env.BROWSERLINK_PORT || 47821);
const CONFIG_DIR = process.env.BROWSERLINK_CONFIG_DIR || path.join(os.homedir(), '.config', 'browserlink');
const TOKEN_FILE = path.join(CONFIG_DIR, 'token');
const REGISTRY_FILE = path.join(CONFIG_DIR, 'sessions.json');
const CHROME_DIR = process.env.BROWSERLINK_CHROME_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- config ----------

fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
if (!fs.existsSync(TOKEN_FILE)) fs.writeFileSync(TOKEN_FILE, crypto.randomBytes(24).toString('hex') + '\n', { mode: 0o600 });
const TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();

// The extension's ID is derived from the public key pinned in its manifest.
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
const EXT_ID = [...crypto.createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)]
  .map(h => String.fromCharCode(97 + parseInt(h, 16))).join('');
const EXT_ORIGIN = `chrome-extension://${EXT_ID}`;

let registry = {};
try { registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')); } catch {}
const saveRegistry = () => fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2));

// Chrome profile names, keyed by signed-in email.
function chromeProfiles() {
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(CHROME_DIR, 'Local State'), 'utf8')).profile?.info_cache || {};
    return Object.entries(cache).map(([dir, p]) => ({ dir, name: p.name, email: (p.user_name || '').toLowerCase() }));
  } catch { return []; }
}

const slug = s => (s || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
const NAME_RE = /^[A-Za-z0-9][\w.-]{0,39}$/;

// ---------- sessions ----------

/** instanceId -> { ws, info, name, conflict, pending: Map, lastFocusAt } */
const sessions = new Map();

// Bounded diagnostic log of browser commands. Records shape and outcome only —
// no URLs, inputs, code or page content — so it is safe to keep and expose.
const journal = [];
let seq = 0;
const MAX_JOURNAL = 500;
function journalAdd(e) { journal.push(e); if (journal.length > MAX_JOURNAL) journal.shift(); }

// Settle every outstanding call on a session (reconnect, disconnect) instead of
// leaving them to time out, and record the uncertain outcome.
function rejectPending(sess, reason) {
  for (const p of sess.pending.values()) {
    clearTimeout(p.timer);
    if (p.journal && p.journal.outcome === 'sent') { p.journal.outcome = reason; p.journal.ms = Date.now() - p.journal.t; }
    p.reject(new Error(`${sess.name || sess.info?.instanceId || 'session'} ${reason}; the browser action's completion is unknown`));
  }
  sess.pending.clear();
}

function findByName(name) {
  const want = name.toLowerCase();
  for (const s of sessions.values()) if (s.name && s.name.toLowerCase() === want) return s;
  return null;
}

function assignName(s) {
  const { instanceId, name: chosen, email } = s.info;
  const profile = email ? chromeProfiles().find(p => p.email === email.toLowerCase()) : null;
  s.profile = profile;
  const base = chosen || slug(profile?.name) || slug(email.split('@')[0]) || instanceId;
  s.conflict = null;
  const clash = findByName(base);
  if (clash && clash !== s) {
    s.name = `${base}-${instanceId.slice(0, 4)}`;
    s.conflict = `wanted "${base}" but session ${clash.info.instanceId} already has it`;
  } else s.name = base;
  registry[instanceId] = { name: s.name, email, profileDir: profile?.dir || null, lastSeen: new Date().toISOString() };
  saveRegistry();
}

function call(s, method, params = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const entry = { seq: ++seq, t: Date.now(), session: s.name, tab: params.tabId ?? null, method, outcome: 'sent', ms: null };
    journalAdd(entry);
    if (!s.ws || s.ws.readyState !== 1) { // 1 = WebSocket.OPEN
      entry.outcome = 'not-sent'; entry.ms = 0;
      return reject(new Error(`session ${s.name} is not connected`));
    }
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      s.pending.delete(id);
      entry.outcome = 'timeout-unknown'; entry.ms = Date.now() - entry.t;
      reject(new Error(`${method} timed out after ${timeoutMs}ms; the browser action may or may not have completed`));
    }, timeoutMs);
    s.pending.set(id, {
      resolve: v => { entry.outcome = 'completed'; entry.ms = Date.now() - entry.t; resolve(v); },
      reject: e => { if (entry.outcome === 'sent') { entry.outcome = 'failed'; entry.ms = Date.now() - entry.t; } reject(e); },
      timer, journal: entry,
    });
    s.ws.send(JSON.stringify({ type: 'call', id, method, params }));
  });
}

function sessionFor(name) {
  if (name) {
    const s = findByName(name);
    if (!s) throw new Error(`no connected session named "${name}". Connected: ${[...sessions.values()].map(x => x.name).join(', ') || 'none'}`);
    return s;
  }
  if (sessions.size === 0) throw new Error('no browser sessions connected — is the BrowserLink extension loaded and the hub reachable?');
  // Default: the session whose window was focused most recently.
  return [...sessions.values()].sort((a, b) => b.lastFocusAt - a.lastFocusAt)[0];
}

// Accepts "work:123", "123" (searched across sessions) or nothing (focused tab of the most recently focused session).
async function resolveTab(tab, session) {
  if (tab && String(tab).includes(':')) {
    const [name, id] = String(tab).split(':');
    return { s: sessionFor(name), tabId: Number(id) };
  }
  if (tab) {
    const id = Number(tab);
    const candidates = session ? [sessionFor(session)] : [...sessions.values()];
    const matches = [];
    for (const s of candidates) {
      const { tabs } = await call(s, 'tabs');
      if (tabs.some(t => t.id === id)) matches.push(s);
    }
    if (matches.length === 0) throw new Error(`tab ${tab} not found`);
    if (matches.length > 1) throw new Error(`tab id ${id} exists in ${matches.length} sessions (${matches.map(s => s.name).join(', ')}); use a "session:tab" handle such as "${matches[0].name}:${id}"`);
    return { s: matches[0], tabId: id };
  }
  const s = sessionFor(session);
  const { tabs, focusedWindowId } = await call(s, 'tabs');
  const t = tabs.find(t => t.active && t.windowId === focusedWindowId) || tabs.find(t => t.active);
  if (!t) throw new Error(`session ${s.name} has no open tabs`);
  return { s, tabId: t.id };
}

// ---------- HTTP + WebSocket ----------

const LOCAL_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);

const MAX_BODY = 4 * 1024 * 1024;

const server = http.createServer(async (req, res) => {
  try {
    // Reject DNS-rebinding and browser-originated requests outright.
    if (!LOCAL_HOSTS.has(req.headers.host) || (req.headers.origin && req.headers.origin !== EXT_ORIGIN)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok: true, sessions: [...sessions.values()].map(s => s.name) }));
      return;
    }
    if (url.pathname !== '/mcp') { res.writeHead(404).end(); return; }
    const auth = req.headers.authorization || '';
    const given = Buffer.from(auth.replace(/^Bearer\s+/i, ''));
    const want = Buffer.from(TOKEN);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) { res.writeHead(401).end('bad token'); return; }

    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return; }
    let body = '', size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) { res.writeHead(413).end('request body too large'); req.destroy(); return; }
      body += chunk;
    }
    let parsed;
    try { parsed = JSON.parse(body); } catch { res.writeHead(400).end('bad json'); return; }
    const mcp = buildMcp();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); mcp.close(); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, parsed);
  } catch (e) {
    log('request error:', e?.message || e);
    if (!res.headersSent) res.writeHead(500).end('internal error');
    else try { res.end(); } catch { /* already closed */ }
  }
});

const wss = new WebSocketServer({
  server,
  path: '/ext',
  verifyClient: ({ req }) => req.headers.origin === EXT_ORIGIN && LOCAL_HOSTS.has(req.headers.host),
});

wss.on('connection', ws => {
  let s = null;
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    try {
      if (msg.type === 'hello') {
        if (typeof msg.instanceId !== 'string' || !msg.instanceId) { ws.close(1008, 'bad hello'); return; }
        msg.email = typeof msg.email === 'string' ? msg.email : '';
        if (s && s.ws === ws) { s.info = msg; assignName(s); return; } // second hello on the same socket: identity update
        const old = sessions.get(msg.instanceId);
        if (old && old.ws !== ws) { rejectPending(old, 'was replaced by a new connection'); try { old.ws.terminate(); } catch {} }
        s = { ws, info: msg, pending: new Map(), lastFocusAt: msg.lastFocusAt || 0, connectedAt: Date.now() };
        assignName(s); // assign the name before registering, so findByName's conflict check ignores this session
        sessions.set(msg.instanceId, s);
        log(`connected ${s.name} (${msg.email || 'no email'}, ${msg.instanceId})${s.conflict ? ' — ' + s.conflict : ''}`);
      } else if (!s) return;
      else if (msg.type === 'result') {
        if (typeof msg.id !== 'string') return;
        const p = s.pending.get(msg.id);
        if (!p) return;
        s.pending.delete(msg.id);
        clearTimeout(p.timer);
        msg.error ? p.reject(new Error(String(msg.error))) : p.resolve(msg.result);
      } else if (msg.type === 'focus') s.lastFocusAt = Number(msg.at) || s.lastFocusAt;
    } catch (e) { log('ws message error:', e?.message || e); }
  });
  ws.on('close', () => {
    if (!s || sessions.get(s.info.instanceId) !== s) return;
    sessions.delete(s.info.instanceId);
    rejectPending(s, 'disconnected');
    log(`disconnected ${s.name}`);
  });
  ws.on('error', () => { try { ws.terminate(); } catch { /* already down */ } });
});

// ---------- MCP tools ----------

const text = t => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }] });
const fail = e => ({ content: [{ type: 'text', text: `Error: ${e.message || e}` }], isError: true });

const tabArg = z.string().optional().describe('Tab handle like "work:1234" (from list_tabs). Omit to use the active tab of the most recently focused browser window.');
const sessionArg = z.string().optional().describe('Session name (see list_sessions). Only needed when tab is omitted or is a bare number.');
const targetArgs = {
  ref: z.string().optional().describe('Element ref from snapshot, e.g. "e12" or "f5:e3" for an iframe.'),
  selector: z.string().optional().describe('CSS selector (pierces open shadow roots). Use when there is no ref.'),
  text: z.string().optional().describe('Visible name of the control, e.g. "Sign in". Exact match preferred, else substring.'),
};
const trustedArg = z.boolean().optional().describe('Use Chrome\'s debugger to send real (isTrusted) input. Only for sites that ignore synthetic events; briefly shows Chrome\'s "started debugging" bar.');

function tool(mcp, name, description, schema, fn) {
  mcp.registerTool(name, { description, inputSchema: schema }, async args => {
    try { return await fn(args); } catch (e) { return fail(e); }
  });
}

// Call a tab-scoped extension command and prefix the result with the tab handle.
async function onTab(args, method, params = {}, timeoutMs) {
  const { s, tabId } = await resolveTab(args.tab, args.session);
  const result = await call(s, method, { tabId, ...params }, timeoutMs);
  return { s, tabId, result, handle: `${s.name}:${tabId}` };
}

// Resolve caller-supplied upload paths to absolute paths that exist on this
// machine (where Chrome runs). "~" is expanded. Throws on a missing file.
function resolveLocalFiles(files) {
  return files.map(f => {
    let p = f;
    if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
    p = path.resolve(p);
    if (!fs.existsSync(p)) throw new Error(`file not found: ${f}`);
    return p;
  });
}

function buildMcp() {
  const mcp = new McpServer({ name: 'browserlink', version: '0.1.0' });

  tool(mcp, 'list_sessions', 'List browser sessions (one per Chrome profile running the BrowserLink extension) with their names, profile and email. Includes recently seen sessions that are offline.', {}, async () => {
    const lines = [];
    for (const s of sessions.values()) {
      let counts = '';
      try { const { tabs } = await call(s, 'tabs', {}, 5000); counts = `${new Set(tabs.map(t => t.windowId)).size} windows, ${tabs.length} tabs`; } catch {}
      lines.push(`● ${s.name} — profile "${s.profile?.name || '?'}" (${s.profile?.dir || 'unknown dir'}), ${s.info.email || 'not signed in'}, ${counts}${s.conflict ? `\n    note: ${s.conflict}; rename it with name_session` : ''}`);
    }
    const online = new Set([...sessions.values()].map(s => s.info.instanceId));
    for (const [id, r] of Object.entries(registry)) {
      if (!online.has(id)) lines.push(`○ ${r.name} — offline (last seen ${r.lastSeen}), ${r.email || 'not signed in'}`);
    }
    const focused = sessions.size ? sessionFor().name : null;
    return text((lines.join('\n') || 'No sessions yet. Load the BrowserLink extension in Chrome.') + (focused ? `\n\nMost recently focused: ${focused}` : ''));
  });

  tool(mcp, 'name_session', 'Give a browser session a new name. Names are unique (case-insensitive): letters, digits, ".", "-", "_". Pass an empty name to go back to the Chrome profile name.', {
    session: z.string().describe('Current session name'),
    name: z.string().describe('New name, or "" to reset'),
  }, async ({ session, name }) => {
    const s = sessionFor(session);
    if (name && !NAME_RE.test(name)) throw new Error('names must start with a letter or digit and use only letters, digits, ".", "-", "_" (max 40)');
    const clash = name && findByName(name);
    if (clash && clash !== s) throw new Error(`"${name}" is already used by another session (${clash.info.email || clash.info.instanceId})`);
    const old = s.name;
    s.info = { ...s.info, ...(await call(s, 'setName', { name })) };
    assignName(s);
    return text(`renamed ${old} → ${s.name}`);
  });

  tool(mcp, 'list_tabs', 'List open tabs in every session (or one). Returns tab handles like "work:1234" for the other tools.', {
    session: z.string().optional().describe('Limit to one session'),
    query: z.string().optional().describe('Only tabs whose title or URL contains this text'),
  }, async ({ session, query }) => {
    const out = [];
    for (const s of session ? [sessionFor(session)] : sessions.values()) {
      const { tabs, focusedWindowId } = await call(s, 'tabs');
      const q = query?.toLowerCase();
      const shown = tabs.filter(t => !q || `${t.title} ${t.url}`.toLowerCase().includes(q));
      out.push(`## ${s.name} (${s.info.email || 'not signed in'})`);
      let win = null;
      for (const t of shown.sort((a, b) => a.windowId - b.windowId)) {
        if (t.windowId !== win) { win = t.windowId; out.push(`window ${win}${win === focusedWindowId ? ' (focused)' : ''}`); }
        out.push(`  ${s.name}:${t.id}${t.active ? ' *' : ''} ${t.title || '(untitled)'} — ${t.url}`);
      }
      if (!shown.length) out.push('  (no matching tabs)');
    }
    return text(out.join('\n') || 'no sessions connected');
  });

  tool(mcp, 'open_tab', 'Open a new tab (or window) in a session.', {
    url: z.string().describe('URL to open'),
    session: sessionArg,
    background: z.boolean().optional().describe('Open without focusing it'),
    new_window: z.boolean().optional(),
  }, async ({ url, session, background, new_window }) => {
    const s = sessionFor(session);
    const t = await call(s, 'open', { url, background, newWindow: new_window }, 30000);
    return text(`opened ${s.name}:${t.id} — ${t.title} — ${t.url}`);
  });

  tool(mcp, 'close_tab', 'Close a tab.', { tab: z.string(), session: sessionArg }, async args => {
    const r = await onTab(args, 'close');
    return text(`closed ${r.handle}`);
  });

  tool(mcp, 'activate_tab', 'Bring a tab to the front and focus its window.', { tab: z.string(), session: sessionArg }, async args => {
    const r = await onTab(args, 'activate');
    return text(`activated ${r.handle}`);
  });

  tool(mcp, 'navigate', 'Load a URL in a tab, or go back/forward/reload. Waits for the page to load.', {
    tab: tabArg, session: sessionArg,
    url: z.string().optional(),
    action: z.enum(['back', 'forward', 'reload']).optional(),
  }, async args => {
    if (!args.url && !args.action) throw new Error('pass url or action');
    const r = await onTab(args, 'navigate', { url: args.url, action: args.action }, 30000);
    return text(`${r.handle} — ${r.result.title} — ${r.result.url}${r.result.note || ''}`);
  });

  tool(mcp, 'snapshot', 'Read the page as an indented outline of text, headings and controls. Each control has a ref like [e12] to use with click/type/etc. Refs stay valid until the element leaves the page. Prefer this over screenshots for reading and acting.', {
    tab: tabArg, session: sessionArg,
    selector: z.string().optional().describe('Only snapshot inside this element'),
    interactive_only: z.boolean().optional().describe('List only controls, no text'),
    max_chars: z.number().optional().describe('Default 30000'),
  }, async args => {
    const r = await onTab(args, 'snapshot', { selector: args.selector, interactiveOnly: args.interactive_only, maxChars: args.max_chars });
    return text(`tab: ${r.handle}\n${r.result}`);
  });

  tool(mcp, 'click', 'Click an element by ref, selector or visible text.', {
    tab: tabArg, session: sessionArg, ...targetArgs, trusted: trustedArg,
    double: z.boolean().optional(),
    button: z.enum(['left', 'right', 'middle']).optional(),
  }, async args => text((await onTab(args, 'click', pick(args, 'ref', 'selector', 'text', 'trusted', 'double', 'button'))).result));

  tool(mcp, 'type', 'Type into a text field or contenteditable. Replaces existing content unless clear=false.', {
    tab: tabArg, session: sessionArg, ...targetArgs,
    value: z.string().describe('Text to enter'),
    clear: z.boolean().optional().describe('Replace current content (default true)'),
    submit: z.boolean().optional().describe('Press Enter afterwards'),
    trusted: trustedArg,
  }, async args => text((await onTab(args, 'type', { ...pick(args, 'ref', 'selector', 'text', 'clear', 'submit', 'trusted'), value: args.value })).result));

  tool(mcp, 'press_key', 'Press a key, optionally on an element. Examples: "Enter", "Escape", "Tab", "ArrowDown", "Meta+a".', {
    tab: tabArg, session: sessionArg, ...targetArgs,
    key: z.string(), trusted: trustedArg,
  }, async args => text((await onTab(args, 'press', pick(args, 'ref', 'selector', 'text', 'key', 'trusted'))).result));

  tool(mcp, 'select_option', 'Choose option(s) in a <select> by value or visible label.', {
    tab: tabArg, session: sessionArg, ...targetArgs,
    values: z.array(z.string()),
  }, async args => text((await onTab(args, 'select', pick(args, 'ref', 'selector', 'text', 'values'))).result));

  tool(mcp, 'hover', 'Hover over an element (to open menus or tooltips).', {
    tab: tabArg, session: sessionArg, ...targetArgs,
  }, async args => text((await onTab(args, 'hover', pick(args, 'ref', 'selector', 'text'))).result));

  tool(mcp, 'scroll', 'Scroll the page, or scroll an element into view.', {
    tab: tabArg, session: sessionArg, ...targetArgs,
    direction: z.enum(['up', 'down', 'left', 'right', 'top', 'bottom']).optional(),
    amount: z.number().optional().describe('Pixels (default: most of a screen)'),
  }, async args => text((await onTab(args, 'scroll', pick(args, 'ref', 'selector', 'text', 'direction', 'amount'))).result));

  tool(mcp, 'screenshot', 'Capture a screenshot of a tab. Works on background tabs (via the debugger) without switching to them.', {
    tab: tabArg, session: sessionArg,
    full_page: z.boolean().optional(),
  }, async args => {
    const r = await onTab(args, 'screenshot', { fullPage: args.full_page }, 30000);
    return { content: [
      { type: 'image', data: r.result.data, mimeType: r.result.mimeType },
      { type: 'text', text: `${r.handle} (${r.result.width}×${r.result.height})` },
    ] };
  });

  tool(mcp, 'get_text', 'Get the visible text of the page or of one element.', {
    tab: tabArg, session: sessionArg,
    selector: z.string().optional(),
    max_chars: z.number().optional().describe('Default 20000'),
  }, async args => text((await onTab(args, 'text', { selector: args.selector, maxChars: args.max_chars })).result));

  tool(mcp, 'evaluate', 'Run JavaScript in the page (main world) and return the result as JSON. Pass an expression, or a function body containing `return`. await is allowed.', {
    tab: tabArg, session: sessionArg,
    code: z.string(),
    frame: z.number().optional().describe('Frame id (the N in f N:e… refs). Default: top frame'),
  }, async args => text((await onTab(args, 'evaluate', { code: args.code, frameId: args.frame ?? 0 }, 60000)).result));

  tool(mcp, 'console_logs', 'Read console output and uncaught errors captured from the page since it loaded (all frames).', {
    tab: tabArg, session: sessionArg,
    level: z.enum(['log', 'info', 'warn', 'error', 'debug']).optional().describe('Only this level'),
    clear: z.boolean().optional().describe('Clear the buffer after reading'),
  }, async args => {
    const r = await onTab(args, 'console', { clear: args.clear });
    const rows = r.result.filter(e => !args.level || e.level === args.level);
    return text(rows.map(e => `${new Date(e.t).toISOString().slice(11, 23)} ${e.level.padEnd(5)} ${e.text}`).join('\n') || '(no console output)');
  });

  tool(mcp, 'network_log', 'List network requests the page made (URL, type, HTTP status, duration, size).', {
    tab: tabArg, session: sessionArg,
    filter: z.string().optional().describe('Only URLs containing this text'),
  }, async args => {
    const r = await onTab(args, 'network');
    const rows = r.result.filter(e => !args.filter || e.url.includes(args.filter));
    return text(rows.map(e => `${String(e.status ?? '-').padEnd(4)} ${e.type.padEnd(14)} ${String(e.ms).padStart(6)}ms ${String(e.bytes ?? '').padStart(8)}B ${e.url}`).join('\n') || '(no requests)');
  });

  tool(mcp, 'wait_for', 'Wait until text or a selector appears (or disappears) on the page.', {
    tab: tabArg, session: sessionArg,
    text: z.string().optional(), selector: z.string().optional(),
    gone: z.boolean().optional().describe('Wait for it to disappear instead'),
    timeout_ms: z.number().optional().describe('Default 10000'),
  }, async args => {
    if (!args.text && !args.selector) throw new Error('pass text or selector');
    const t = args.timeout_ms ?? 10000;
    return text((await onTab(args, 'waitFor', { text: args.text, selector: args.selector, gone: args.gone, timeoutMs: t }, t + 5000)).result);
  });

  tool(mcp, 'file_upload', 'Attach local file(s) to a file input (an <input type="file">), chosen by ref, selector or visible text. Give absolute paths on this machine ("~" is allowed). Replaces any current selection. Use this instead of clicking the input, which would open the OS file picker.', {
    tab: tabArg, session: sessionArg, ...targetArgs,
    files: z.array(z.string()).min(1).describe('Absolute local file paths. Pass more than one only if the input allows multiple.'),
  }, async args => {
    const files = resolveLocalFiles(args.files);
    return text((await onTab(args, 'fileUpload', { ...pick(args, 'ref', 'selector', 'text'), files }, 30000)).result);
  });

  tool(mcp, 'handle_dialog', 'Control how JavaScript dialogs (alert/confirm/prompt) and "leave site?" (beforeunload) prompts are answered on a tab, and read recent ones. By default BrowserLink auto-answers them so they never block automation: alert is acknowledged, confirm and prompt are cancelled, and beforeunload is suppressed. Set accept=true (optionally with prompt_text) before an action when you want to confirm or fill a prompt.', {
    tab: tabArg, session: sessionArg,
    accept: z.boolean().optional().describe('Answer confirm/prompt with OK (true) or Cancel (false).'),
    prompt_text: z.string().optional().describe('Text to return from prompt() when accepting.'),
    scope: z.enum(['next', 'always']).optional().describe('Apply to only the next dialog, or until changed (default always).'),
    suppress_beforeunload: z.boolean().optional().describe('Suppress "leave site?" prompts (default true).'),
    read: z.boolean().optional().describe('Also return recent dialogs seen on this tab.'),
    clear: z.boolean().optional().describe('Clear the dialog history after reading.'),
  }, async args => {
    const { result } = await onTab(args, 'dialog', {
      accept: args.accept, promptText: args.prompt_text, suppressBeforeunload: args.suppress_beforeunload,
      scope: args.scope, read: args.read, clear: args.clear,
    });
    const p = result.policy;
    const lines = [];
    if (p) lines.push(`policy: confirm/prompt ${p.accept ? 'ACCEPT' : 'dismiss'}${p.promptText != null ? ` (prompt text "${p.promptText}")` : ''}, beforeunload ${p.suppressBeforeunload ? 'suppressed' : 'shown'}`);
    if (args.read) lines.push(result.dialogs.length
      ? 'recent dialogs:\n' + result.dialogs.map(d => `  ${new Date(d.t).toISOString().slice(11, 19)} ${d.answered} ${d.type}${d.type !== 'beforeunload' && d.message ? ` "${d.message.slice(0, 140)}"` : ''}`).join('\n')
      : 'recent dialogs: none');
    return text(lines.join('\n') || 'ok');
  });

  tool(mcp, 'activity', 'Recent browser commands the hub has run, newest last: time, session, tab, method, outcome and latency. Outcomes: sent, completed, failed, timeout-unknown (dispatched but no reply before the deadline, so it may still have happened), not-sent, disconnected. A diagnostic log that records no URLs, inputs, code or page content.', {
    limit: z.number().optional().describe('How many recent entries to show (default 50)'),
    clear: z.boolean().optional().describe('Clear the log after reading'),
  }, async ({ limit = 50, clear = false }) => {
    const rows = journal.slice(-limit).map(e =>
      `${new Date(e.t).toISOString().slice(11, 23)} ${String(e.session || '?').padEnd(14)} tab=${e.tab ?? '-'} ${String(e.method).padEnd(11)} ${e.outcome}${e.ms != null ? ` ${e.ms}ms` : ''}`);
    const out = rows.join('\n') || '(no activity yet)';
    if (clear) journal.length = 0;
    return text(out);
  });

  return mcp;
}

function pick(o, ...keys) {
  const out = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

server.listen(PORT, '127.0.0.1', () => log(`BrowserLink hub on 127.0.0.1:${PORT}, extension ${EXT_ID}`));
