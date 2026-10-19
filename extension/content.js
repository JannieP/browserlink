// Injected on demand into every frame (isolated world). Builds page snapshots
// with stable element refs and performs DOM-level actions on them.
(() => {
  if (window.__browserlink) return;

  const refs = new Map();      // ref -> WeakRef<Element>
  const refOfEl = new WeakMap();
  let seq = 0;

  const refOf = el => {
    let r = refOfEl.get(el);
    if (!r) {
      r = 'e' + (++seq);
      refOfEl.set(el, r);
      refs.set(r, new WeakRef(el));
    }
    return r;
  };

  const clean = (s, max = 120) => {
    s = (s || '').replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max) + '…' : s;
  };

  const visible = el => {
    if (el.checkVisibility) return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const INTERACTIVE_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'option', 'switch', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'treeitem']);
  const LANDMARKS = { NAV: 'navigation', MAIN: 'main', HEADER: 'banner', FOOTER: 'contentinfo', FORM: 'form',
    DIALOG: 'dialog', ASIDE: 'complementary', TABLE: 'table', UL: 'list', OL: 'list' };
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'svg', 'HEAD', 'META', 'LINK']);

  const roleOf = el => {
    const r = el.getAttribute('role');
    if (r) return r.split(/\s+/)[0];
    const t = el.tagName;
    if (t === 'A') return 'link';
    if (t === 'BUTTON' || t === 'SUMMARY') return 'button';
    if (t === 'SELECT') return 'combobox';
    if (t === 'TEXTAREA') return 'textbox';
    if (t === 'INPUT') {
      return ({ checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button', reset: 'button',
        image: 'button', range: 'slider', search: 'searchbox', file: 'filepicker', number: 'spinbutton' })[el.type] || 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return 'clickable';
  };

  const isInteractive = el => {
    const t = el.tagName;
    if (t === 'A' && el.hasAttribute('href')) return true;
    if (t === 'BUTTON' || t === 'SELECT' || t === 'TEXTAREA' || t === 'SUMMARY') return true;
    if (t === 'INPUT') return el.type !== 'hidden';
    const role = el.getAttribute('role');
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    if (el.isContentEditable && !el.parentElement?.isContentEditable) return true;
    if (el.hasAttribute('onclick')) return true;
    const ti = el.getAttribute('tabindex');
    if (ti !== null && +ti >= 0 && t !== 'DIV' && t !== 'SECTION') return true;
    // cursor:pointer marks custom clickables; only count where it starts, not where it is inherited.
    if (getComputedStyle(el).cursor === 'pointer') {
      const p = el.parentElement;
      return !p || getComputedStyle(p).cursor !== 'pointer';
    }
    return false;
  };

  const nameOf = el => {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb.split(/\s+/).map(id => el.ownerDocument.getElementById(id)?.innerText || '').join(' ');
      if (clean(t)) return clean(t);
    }
    if (el.labels?.length) {
      const t = [...el.labels].map(l => l.innerText).join(' ');
      if (clean(t)) return clean(t);
    }
    if (el.tagName === 'IMG') return clean(el.alt);
    if (el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(el.type)) return clean(el.value);
    if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) {
      const t = clean(el.innerText);
      if (t) return t;
    }
    return clean(el.getAttribute('placeholder') || el.getAttribute('title') || el.querySelector?.('img[alt]')?.alt || '');
  };

  const stateOf = el => {
    const s = [];
    const t = el.tagName;
    if (t === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) s.push(el.checked ? 'checked' : 'unchecked');
    else if (el.getAttribute('aria-checked')) s.push('checked=' + el.getAttribute('aria-checked'));
    if (t === 'INPUT' || t === 'TEXTAREA') {
      if (el.type === 'password') s.push(el.value ? 'value=•••' : 'empty');
      else if (el.type !== 'checkbox' && el.type !== 'radio') s.push(el.value ? `value="${clean(el.value, 80)}"` : 'empty');
      if (el.placeholder && nameOf(el) !== clean(el.placeholder)) s.push(`placeholder="${clean(el.placeholder, 40)}"`);
    }
    if (t === 'SELECT') {
      const opts = [...el.options];
      s.push(`selected="${clean(opts.filter(o => o.selected).map(o => o.text).join(', '), 60)}"`);
      s.push('options=[' + opts.slice(0, 25).map(o => JSON.stringify(clean(o.text, 40))).join(', ') + (opts.length > 25 ? ', …' : '') + ']');
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') s.push('disabled');
    if (el.getAttribute('aria-expanded')) s.push('expanded=' + el.getAttribute('aria-expanded'));
    if (el.getAttribute('aria-selected') === 'true') s.push('selected');
    if (t === 'A') {
      const h = el.getAttribute('href') || '';
      if (h && !h.startsWith('javascript:')) s.push('-> ' + clean(h.startsWith(location.origin) ? h.slice(location.origin.length) : h, 80));
    }
    if (el === document.activeElement) s.push('focused');
    return s.join(' ');
  };

  // Walk the DOM (including open shadow roots) into an indented outline.
  const snapshot = ({ selector, interactiveOnly = false, maxChars = 30000 } = {}) => {
    const root = selector ? deepQuery(selector) : document.body;
    if (!root) throw new Error(`no element matches ${selector}`);
    const lines = [];
    let size = 0, truncated = false;
    const emit = (depth, text) => {
      if (truncated) return;
      const line = '  '.repeat(depth) + text;
      size += line.length + 1;
      if (size > maxChars) { truncated = true; return; }
      lines.push(line);
    };

    const walk = (node, depth) => {
      if (truncated) return;
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === Node.TEXT_NODE) {
          if (interactiveOnly) continue;
          const t = clean(child.textContent, 300);
          if (t && child.parentElement && visible(child.parentElement)) {
            const prev = lines[lines.length - 1];
            const pad = '  '.repeat(depth);
            if (prev && prev.startsWith(pad + '"') && prev.length < 400) lines[lines.length - 1] = prev.slice(0, -1) + ' ' + t + '"';
            else emit(depth, `"${t}"`);
          }
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        const el = child;
        if (SKIP.has(el.tagName) || el.getAttribute('aria-hidden') === 'true') continue;
        if (!visible(el) && el.tagName !== 'DETAILS' && !el.shadowRoot) {
          // display:contents and similar report invisible but have visible children
          if (getComputedStyle(el).display !== 'contents') continue;
        }
        if (isInteractive(el)) {
          const st = stateOf(el);
          emit(depth, `${roleOf(el)} "${nameOf(el)}" [${refOf(el)}]${st ? ' ' + st : ''}`);
          // Descend only into containers that hold other controls (menus, custom widgets).
          if (el.tagName !== 'SELECT' && el.querySelector('a[href],button,input,select,textarea,[role]')) walk(el, depth + 1);
          continue;
        }
        if (/^H[1-6]$/.test(el.tagName)) {
          emit(depth, `heading${el.tagName[1]} "${clean(el.innerText, 200)}"`);
          continue;
        }
        if (el.tagName === 'IMG') {
          if (!interactiveOnly && el.alt) emit(depth, `img "${clean(el.alt, 80)}"`);
          continue;
        }
        if (el.tagName === 'IFRAME') {
          emit(depth, `iframe "${clean(el.title || el.name || el.src, 80)}" (see its frame section below)`);
          continue;
        }
        const lm = el.getAttribute('role') === 'dialog' || el.getAttribute('aria-modal') === 'true' ? 'dialog' : LANDMARKS[el.tagName];
        if (lm && !interactiveOnly) {
          const label = clean(el.getAttribute('aria-label') || '', 60);
          emit(depth, `${lm}${label ? ` "${label}"` : ''}:`);
          walk(el.shadowRoot || el, depth + 1);
          continue;
        }
        walk(el.shadowRoot || el, depth);
      }
    };
    walk(root.shadowRoot || root, 0);
    const head = `title: ${document.title}\nurl: ${location.href}\n`;
    return head + lines.join('\n') + (truncated ? `\n… (truncated at ${maxChars} chars; pass selector to narrow or raise max_chars)` : '');
  };

  const deepQuery = (selector, root = document) => {
    const hit = root.querySelector(selector);
    if (hit) return hit;
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        const h = deepQuery(selector, el.shadowRoot);
        if (h) return h;
      }
    }
    return null;
  };

  const findByText = text => {
    const want = text.toLowerCase();
    let best = null;
    const all = document.querySelectorAll('a,button,input,select,textarea,summary,label,[role],[onclick],[tabindex]');
    for (const el of all) {
      if (!visible(el)) continue;
      const n = nameOf(el).toLowerCase();
      if (n === want) return el;
      if (!best && n.includes(want)) best = el;
    }
    return best;
  };

  const resolve = ({ ref, selector, text }) => {
    if (ref) {
      const el = refs.get(ref)?.deref();
      if (!el || !el.isConnected) throw new Error(`ref ${ref} is stale or unknown — take a new snapshot`);
      return el;
    }
    if (selector) {
      const el = deepQuery(selector);
      if (!el) throw new Error(`no element matches selector ${selector}`);
      return el;
    }
    if (text) {
      const el = findByText(text);
      if (!el) throw new Error(`no visible control named "${text}"`);
      return el;
    }
    throw new Error('need ref, selector or text');
  };

  const describe = el => `${roleOf(el)} "${nameOf(el)}" [${refOf(el)}]`;

  const center = el => {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };

  const mouse = (el, type, { x, y }, extra = {}) => {
    const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
    el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y,
      view: window, pointerId: 1, pointerType: 'mouse', isPrimary: true, ...extra }));
  };

  const click = (el, { double = false, button = 'left' } = {}) => {
    const pt = center(el);
    const b = { left: 0, middle: 1, right: 2 }[button] ?? 0;
    mouse(el, 'pointerover', pt); mouse(el, 'mouseover', pt);
    mouse(el, 'pointerdown', pt, { button: b, buttons: 1 }); mouse(el, 'mousedown', pt, { button: b, buttons: 1 });
    if (el.focus && document.activeElement !== el) el.focus({ preventScroll: true });
    mouse(el, 'pointerup', pt, { button: b }); mouse(el, 'mouseup', pt, { button: b });
    if (b === 2) mouse(el, 'contextmenu', pt, { button: 2 });
    else if (b === 0) {
      el.click();
      if (double) { el.click(); mouse(el, 'dblclick', pt, { detail: 2 }); }
    }
    return describe(el);
  };

  const setNativeValue = (el, value) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  };

  const type = (el, text, { clear = true } = {}) => {
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.focus();
    if (el.isContentEditable) {
      if (clear) document.execCommand('selectAll');
      document.execCommand('insertText', false, text);
      return describe(el);
    }
    if (!('value' in el)) throw new Error(`${describe(el)} is not a text field`);
    if (clear) el.select?.();
    else { try { el.setSelectionRange(el.value.length, el.value.length); } catch {} }
    // execCommand produces trusted input events that frameworks accept; fall back to the native setter.
    const before = el.value;
    const ok = document.execCommand('insertText', false, text);
    const expected = clear ? text : before + text;
    if (!ok || el.value !== expected) {
      setNativeValue(el, expected);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return describe(el);
  };

  const KEYS = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37,
    ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34, ' ': 32 };

  const press = (el, key) => {
    const target = el || document.activeElement || document.body;
    const parts = key.split('+');
    const k = parts.pop();
    const mods = { ctrlKey: parts.includes('Control'), shiftKey: parts.includes('Shift'), altKey: parts.includes('Alt'), metaKey: parts.includes('Meta') };
    const init = { key: k, code: k.length === 1 ? 'Key' + k.toUpperCase() : k, keyCode: KEYS[k] || k.toUpperCase().charCodeAt(0),
      which: KEYS[k] || 0, bubbles: true, cancelable: true, composed: true, ...mods };
    const notCancelled = target.dispatchEvent(new KeyboardEvent('keydown', init));
    if (k.length === 1 && notCancelled) target.dispatchEvent(new KeyboardEvent('keypress', init));
    if (notCancelled) {
      if (k === 'Enter' && target.form && target.tagName === 'INPUT') target.form.requestSubmit();
      else if (k === 'Enter' && (target.tagName === 'A' || target.tagName === 'BUTTON')) target.click();
      else if (k === 'Tab') {
        const f = [...document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])')]
          .filter(e => !e.disabled && visible(e));
        const i = f.indexOf(target);
        f[(i + (mods.shiftKey ? -1 : 1) + f.length) % f.length]?.focus();
      }
    }
    target.dispatchEvent(new KeyboardEvent('keyup', init));
    return `pressed ${key} on ${target === document.body ? 'page' : describe(target)}`;
  };

  const select = (el, values) => {
    if (el.tagName !== 'SELECT') throw new Error(`${describe(el)} is not a <select>; click it and pick the option instead`);
    const want = values.map(v => String(v).toLowerCase());
    let hit = 0;
    for (const o of el.options) {
      const on = want.includes(o.value.toLowerCase()) || want.includes(o.text.trim().toLowerCase());
      if (on) hit++;
      if (el.multiple || on) o.selected = on;
    }
    if (!hit) throw new Error(`no option matching ${JSON.stringify(values)}`);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return `${describe(el)} now ${stateOf(el)}`;
  };

  const hover = el => {
    const pt = center(el);
    for (const t of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) mouse(el, t, pt);
    return describe(el);
  };

  const scroll = ({ target, direction = 'down', amount }) => {
    if (target) { const el = resolve(target); center(el); return `scrolled to ${describe(el)}`; }
    const h = amount ?? Math.round(innerHeight * 0.8);
    if (direction === 'top') scrollTo(0, 0);
    else if (direction === 'bottom') scrollTo(0, document.documentElement.scrollHeight);
    else scrollBy({ up: [0, -h], down: [0, h], left: [-h, 0], right: [h, 0] }[direction] || [0, h]);
    return `scrolled ${direction}; now at y=${Math.round(scrollY)} of ${document.documentElement.scrollHeight}`;
  };

  const waitFor = async ({ text, selector, gone = false, timeoutMs = 10000 }) => {
    const end = Date.now() + timeoutMs;
    const present = () => selector ? !!(deepQuery(selector) && visible(deepQuery(selector)))
      : (document.body?.innerText || '').toLowerCase().includes(text.toLowerCase());
    while (Date.now() < end) {
      if (present() !== gone) return true;
      await new Promise(r => setTimeout(r, 200));
    }
    return false;
  };

  const ops = {
    snapshot: a => snapshot(a),
    click: a => click(resolve(a), a),
    type: a => {
      const el = resolve(a);
      const d = type(el, a.value, a);
      if (a.submit) press(el, 'Enter');
      return d;
    },
    press: a => press(a.ref || a.selector || a.text ? resolve(a) : null, a.key),
    select: a => select(resolve(a), a.values),
    hover: a => hover(resolve(a)),
    scroll: a => scroll(a),
    waitFor: a => waitFor(a),
    text: ({ selector, maxChars = 20000 }) => {
      const el = selector ? deepQuery(selector) : document.body;
      if (!el) throw new Error(`no element matches ${selector}`);
      const t = (el.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
      return t.length > maxChars ? t.slice(0, maxChars) + `\n… (truncated, ${t.length} chars total)` : t;
    },
    // Viewport coordinates for trusted (debugger) input. Only meaningful in the top frame.
    point: a => { const el = resolve(a); return { ...center(el), desc: describe(el) }; },
    focus: a => { const el = resolve(a); el.scrollIntoView({ block: 'center', behavior: 'instant' }); el.focus();
      if (a.clear) { if (el.isContentEditable) document.execCommand('selectAll'); else el.select?.(); }
      return describe(el); },
    describe: a => describe(resolve(a)),
  };

  Object.defineProperty(window, '__browserlink', {
    value: {
      async run(op, args) {
        if (!ops[op]) throw new Error('unknown op ' + op);
        return ops[op](args || {});
      },
    },
  });
})();
