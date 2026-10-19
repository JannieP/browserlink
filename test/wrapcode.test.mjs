// Exercises the real looksLikeBody/wrapCode from extension/background.js by
// extracting the sentinel-delimited block and running it in a VM — no Chrome
// APIs involved. Covers the return-detection bug reported in review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './helpers.mjs';

const src = fs.readFileSync(path.join(ROOT, 'extension', 'background.js'), 'utf8');
const m = src.match(/\/\/ <evalwrap>[^\n]*\n([\s\S]*?)\/\/ <\/evalwrap>/);
if (!m) throw new Error('evalwrap sentinels not found in extension/background.js');

const ctx = vm.createContext({});
vm.runInContext(m[1] + '\nthis.looksLikeBody = looksLikeBody; this.wrapCode = wrapCode;', ctx);

async function run(code, asBody) {
  const sandbox = vm.createContext({});
  return vm.runInContext(ctx.wrapCode(code, asBody), sandbox);
}

test('expression vs statement-body detection', () => {
  assert.equal(ctx.looksLikeBody('1 + 2'), false);
  assert.equal(ctx.looksLikeBody('"return"'), false);
  assert.equal(ctx.looksLikeBody('[1, 2].map(x => { return x * 2; })'), false);
  assert.equal(ctx.looksLikeBody('foo({ a: 1, b: 2 })'), false);
  assert.equal(ctx.looksLikeBody('return 5'), true);
  assert.equal(ctx.looksLikeBody('const x = 1; return x'), true);
});

test('wrapped code returns the right value for the cases the old check broke', async () => {
  assert.equal(await run('1 + 2'), '3');
  assert.equal(await run('"return"'), '"return"');
  assert.equal(await run('[1, 2].map(x => { return x * 2; })'), '[\n  2,\n  4\n]');
  assert.equal(await run('const x = 2; return x * 3'), '6');
  assert.equal(await run('undefined'), 'undefined');
});

test('explicit body flag overrides detection', async () => {
  assert.equal(await run('return 7', true), '7');
  assert.equal(await run('5 * 5', false), '25');
});
