// Runs in the page's MAIN world at document_start. Records console output and
// uncaught errors into a small ring buffer that the extension reads on demand.
(() => {
  if (window.__browserlinkCapture) return;
  const MAX = 500;
  const buf = [];
  const push = (level, args) => {
    let text;
    try {
      text = args.map(a => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.stack || String(a);
        try { return JSON.stringify(a); } catch { return String(a); }
      }).join(' ');
    } catch { text = '[unserialisable]'; }
    buf.push({ t: Date.now(), level, text: text.length > 2000 ? text.slice(0, 2000) + '…' : text });
    if (buf.length > MAX) buf.shift();
  };
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = console[level];
    console[level] = function (...args) { push(level, args); return orig.apply(this, args); };
  }
  window.addEventListener('error', e => push('error', [e.error || e.message]), true);
  window.addEventListener('unhandledrejection', e => push('error', ['Unhandled rejection:', e.reason]));
  Object.defineProperty(window, '__browserlinkCapture', {
    value: { read(clear) { const out = buf.slice(); if (clear) buf.length = 0; return out; } },
    enumerable: false,
  });
})();
