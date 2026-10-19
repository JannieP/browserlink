// Test helpers: start the real hub as a child process against a throwaway
// config dir and a random port, so tests never touch ~/.config/browserlink,
// the login agent, or the production port.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SERVER = path.join(ROOT, 'hub', 'server.js');

// The extension origin the hub expects, derived exactly as the hub does.
export function extOrigin() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
  const id = [...crypto.createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)]
    .map(h => String.fromCharCode(97 + parseInt(h, 16))).join('');
  return `chrome-extension://${id}`;
}

export async function waitFor(fn, ms = 3000, every = 40) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise(r => setTimeout(r, every));
  }
}

export async function startHub() {
  const port = 40000 + Math.floor(Math.random() * 20000);
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-test-'));
  const token = 'test-' + crypto.randomBytes(8).toString('hex');
  fs.writeFileSync(path.join(configDir, 'token'), token + '\n');
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      BROWSERLINK_PORT: String(port),
      BROWSERLINK_CONFIG_DIR: configDir,
      BROWSERLINK_CHROME_DIR: path.join(configDir, 'no-chrome-here'), // nonexistent -> no profiles
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8000;
  for (;;) {
    try { const r = await fetch(base + '/health'); if (r.ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) { child.kill('SIGKILL'); throw new Error('hub did not start'); }
    await new Promise(r => setTimeout(r, 40));
  }
  const hub = {
    port, token, base, origin: extOrigin(), child,
    async mcp(method, params) {
      const r = await fetch(base + '/mcp', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      return { status: r.status, json: r.status === 200 ? await r.json() : null };
    },
    async callTool(name, args = {}) {
      const r = await this.mcp('tools/call', { name, arguments: args });
      const result = r.json?.result;
      return { isError: !!result?.isError, text: result?.content?.[0]?.text ?? '', status: r.status };
    },
    async stop() {
      await new Promise(r => { child.on('exit', r); child.kill('SIGTERM'); setTimeout(r, 1500); });
      try { fs.rmSync(configDir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
  return hub;
}
