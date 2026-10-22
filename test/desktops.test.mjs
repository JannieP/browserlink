// Unit tests for matchDesktops() — the pure function that maps the OS window
// list (from the macOS Spaces helper) onto the extension's windows. Extracted
// from hub/server.js via sentinels and run in a VM, like wrapcode.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './helpers.mjs';

const src = fs.readFileSync(path.join(ROOT, 'hub', 'server.js'), 'utf8');
const m = src.match(/\/\/ <desktopmatch>[^\n]*\n([\s\S]*?)\/\/ <\/desktopmatch>/);
if (!m) throw new Error('desktopmatch sentinels not found in hub/server.js');
const ctx = vm.createContext({});
vm.runInContext(m[1] + '\nthis.matchDesktops = matchDesktops;', ctx);
const matchDesktops = ctx.matchDesktops;

const os = {
  activeSpace: 13,
  windows: [
    { cgid: 101, bounds: [-4770, -388, 2353, 1370], title: 'Inbox - Gmail', desktop: 2, display: 0, onActiveDesktop: true },
    { cgid: 102, bounds: [-2555, -408, 2353, 1369], title: '(2) YouTube',   desktop: 3, display: 0, onActiveDesktop: false },
  ],
};

test('matches windows by active-tab title and carries desktop + current flag', () => {
  const extWindows = [
    { id: 1, left: -2555, top: -408, width: 2353, height: 1369 },
    { id: 2, left: -4770, top: -388, width: 2353, height: 1370 },
  ];
  const extTabs = [
    { windowId: 1, active: true, title: '(2) YouTube' },
    { windowId: 2, active: true, title: 'Inbox - Gmail' },
  ];
  const map = matchDesktops(os, extWindows, extTabs);
  assert.equal(map.get(1).desktop, 3);
  assert.equal(map.get(1).onActiveDesktop, false);
  assert.equal(map.get(2).desktop, 2);
  assert.equal(map.get(2).onActiveDesktop, true);
});

test('falls back to nearest bounds when titles are unavailable to the helper', () => {
  const osNoTitles = { activeSpace: 13, windows: [
    { cgid: 101, bounds: [0, 0, 1000, 800],    title: '', desktop: 2, display: 0, onActiveDesktop: true },
    { cgid: 102, bounds: [2000, 0, 1000, 800],  title: '', desktop: 5, display: 1, onActiveDesktop: false },
  ]};
  const map = matchDesktops(osNoTitles, [{ id: 7, left: 2003, top: 1, width: 1000, height: 800 }], [{ windowId: 7, active: true, title: '' }]);
  assert.equal(map.get(7).desktop, 5);
});

test('a far-off window matches nothing (threshold guards against false pairings)', () => {
  const osOne = { activeSpace: 13, windows: [{ cgid: 101, bounds: [0, 0, 1000, 800], title: '', desktop: 2, display: 0, onActiveDesktop: true }] };
  const map = matchDesktops(osOne, [{ id: 7, left: 9000, top: 9000, width: 400, height: 400 }], [{ windowId: 7, active: true, title: '' }]);
  assert.equal(map.size, 0);
});

test('each OS window is claimed by at most one extension window', () => {
  const osOne = { activeSpace: 13, windows: [{ cgid: 101, bounds: [0, 0, 1000, 800], title: 'Same', desktop: 2, display: 0, onActiveDesktop: true }] };
  const extWindows = [
    { id: 1, left: 0, top: 0, width: 1000, height: 800 },
    { id: 2, left: 5, top: 5, width: 1000, height: 800 },
  ];
  const extTabs = [{ windowId: 1, active: true, title: 'Same' }, { windowId: 2, active: true, title: 'Same' }];
  const map = matchDesktops(osOne, extWindows, extTabs);
  assert.equal(map.size, 1);
  assert.ok(map.has(1));
});

test('no OS data yields an empty map (graceful on non-mac or helper failure)', () => {
  assert.equal(matchDesktops(null, [{ id: 1, left: 0, top: 0, width: 10, height: 10 }], []).size, 0);
  assert.equal(matchDesktops({ windows: [] }, [{ id: 1 }], []).size, 0);
});
