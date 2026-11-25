'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const asar = require('../scripts/asar');
const { stage } = require('../scripts/hud');
const { hudSource } = require('../src/main/ui-source');

test('HUD patches only the two compatible Electron files and preserves other ASAR entries', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hud-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const seed = path.join(dir, 'seed.asar');
  const original = path.join(dir, 'original.asar');
  const output = path.join(dir, 'patched.asar');
  const header = Buffer.alloc(28);
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(20, 4);
  header.writeUInt32LE(16, 8);
  header.writeUInt32LE(12, 12);
  header.write('{"files":{}}', 16);
  fs.writeFileSync(seed, header);
  const utils = 'function getHubWebContents(win) { return win.webContents; }\n  void loadHubWindowUrl(win, url);\n';
  const preload = 'const electron_1 = require("electron");\n';
  asar.repackAsarWithOverlay(seed, original, { additions: new Map([
    ['dist/utils.js', Buffer.from(utils)],
    ['dist/preload.js', Buffer.from(preload)],
    ['dist/untouched.bin', Buffer.from([13, 32, 17])]
  ]) });
  const baseHash = asar.sha256File(original);
  assert.match(stage(original, output, '2.35.1', baseHash), /^[0-9a-f]{64}$/);
  assert.equal(asar.sha256File(original), baseHash);
  assert.deepEqual(asar.extractAsarFile(output, 'dist/untouched.bin'), Buffer.from([13, 32, 17]));
  assert.match(asar.extractAsarFile(output, 'dist/utils.js').toString(), /attachHud\(getHubWebContents\(win\), url\)/);
  assert.match(asar.extractAsarFile(output, 'dist/preload.js').toString(), /exposeInIsolatedWorld\(1009/);
  assert.equal(JSON.parse(asar.extractAsarFile(output, 'dist/agy-liquid-monitor/installation.json')).originalHash, baseHash);
  assert.throws(() => stage(output, path.join(dir, 'double.asar'), '2.35.1', baseHash), /原始 Antigravity/);
  assert.doesNotThrow(() => new vm.Script(hudSource()));
});
