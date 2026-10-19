// Runs in the page's MAIN world at document_start. Three jobs:
//  1. Record console output and uncaught errors into a ring buffer.
//  2. Neutralise JavaScript dialogs (alert/confirm/prompt) and "leave site?"
//     (beforeunload) prompts so they never block automation, recording each.
//  3. Track in-flight fetch/XHR so the extension can wait for the network to
//     go quiet without attaching the debugger.
(() => {
  if (window.__browserlinkCapture) return;

  // ---------- console capture ----------
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

  // ---------- dialog neutralisation ----------
  // Default policy auto-answers so a dialog never freezes the page: alert is
  // acknowledged, confirm/prompt are cancelled, beforeunload is suppressed.
  const policy = { accept: false, promptText: null, suppressBeforeunload: true };
  let once = null; // one-shot override for the next dialog: { accept, promptText }
  const dialogLog = [];
  let fresh = []; // seen since the last drain (for per-action notes)
  const recordDialog = (type, message, answered) => {
    const entry = { t: Date.now(), type, message: String(message ?? '').replace(/\s+/g, ' ').slice(0, 500), answered };
    dialogLog.push(entry); if (dialogLog.length > 100) dialogLog.shift();
    fresh.push(entry); if (fresh.length > 50) fresh.shift();
    return entry;
  };
  const takeAnswer = () => { const a = once || policy; once = null; return a; };

  window.alert = function (message) { recordDialog('alert', message, 'acknowledged'); };
  window.confirm = function (message) {
    const ok = !!takeAnswer().accept;
    recordDialog('confirm', message, ok ? 'accepted' : 'dismissed');
    return ok;
  };
  window.prompt = function (message, def) {
    const a = takeAnswer();
    if (a.accept) {
      const v = a.promptText != null ? a.promptText : (def != null ? def : '');
      recordDialog('prompt', message, 'accepted');
      return v;
    }
    recordDialog('prompt', message, 'dismissed');
    return null;
  };
  // A capturing listener registered at document_start runs before any page
  // handler; stopImmediatePropagation prevents them from setting returnValue,
  // which is what would otherwise trigger the "leave site?" prompt.
  window.addEventListener('beforeunload', e => {
    if (!policy.suppressBeforeunload) return;
    e.stopImmediatePropagation();
    recordDialog('beforeunload', location.href, 'suppressed');
  }, true);

  // ---------- network in-flight tracking ----------
  let inflight = 0;
  let lastChangeAt = Date.now();
  const bump = d => { inflight = Math.max(0, inflight + d); lastChangeAt = Date.now(); };

  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (...args) {
      bump(1);
      let p;
      try { p = origFetch.apply(this, args); } catch (e) { bump(-1); throw e; }
      return p.finally(() => bump(-1));
    };
  }
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype && XHR.prototype.send) {
    const send = XHR.prototype.send;
    XHR.prototype.send = function (...args) {
      let counted = true;
      bump(1);
      const done = () => { if (counted) { counted = false; bump(-1); } };
      try { this.addEventListener('loadend', done); } catch { /* ignore */ }
      try { return send.apply(this, args); }
      catch (e) { done(); throw e; }
    };
  }

  // Resolve once the document is loaded and no fetch/XHR has been in flight for
  // `quietMs`, or after `timeoutMs`. WebSocket/EventSource/streaming are not
  // counted, so they do not hold this open.
  const settled = ({ quietMs = 400, timeoutMs = 8000 } = {}) => new Promise(resolve => {
    const start = Date.now();
    const tick = () => {
      const quiet = inflight === 0 && (Date.now() - lastChangeAt) >= quietMs;
      if (document.readyState === 'complete' && quiet) return resolve('idle');
      if (Date.now() - start >= timeoutMs) return resolve('timeout');
      setTimeout(tick, 100);
    };
    tick();
  });

  Object.defineProperty(window, '__browserlinkCapture', {
    value: {
      read(clear) { const out = buf.slice(); if (clear) buf.length = 0; return out; },
      dialogs(clear) { const out = dialogLog.slice(); if (clear) dialogLog.length = 0; return out; },
      drainFresh() { const out = fresh; fresh = []; return out; },
      setDialogPolicy(p) {
        if (p && typeof p === 'object') {
          if (p.scope === 'next') once = { accept: !!p.accept, promptText: p.promptText ?? null };
          else {
            if ('accept' in p && p.accept !== undefined) policy.accept = !!p.accept;
            if ('promptText' in p && p.promptText !== undefined) policy.promptText = p.promptText ?? null;
            if ('suppressBeforeunload' in p && p.suppressBeforeunload !== undefined) policy.suppressBeforeunload = !!p.suppressBeforeunload;
          }
        }
        return { policy: { ...policy }, once };
      },
      settled(o) { return settled(o); },
      net() { return { inflight, lastChangeAt }; },
    },
    enumerable: false,
  });
})();
