'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('the MCP server exposes the dashboard and an offline, read-only snapshot', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-mcp-'));
  t.after(() => fs.rmdirSync(dir));
  const uri = 'ui://agy-liquid-monitor/dashboard.html';
  const requests = [
    ['initialize', { protocolVersion: '2025-06-18' }],
    ['tools/list'],
    ['resources/read', { uri }],
    ['tools/call', { name: 'monitor_snapshot', arguments: { period: '7D', context: true } }],
    ['resources/read', { uri: 'file:///not-a-dashboard' }]
  ];
  const input = requests.map(([method, params], id) =>
    JSON.stringify({ jsonrpc: '2.0', id, method, params })).join('\n');
  const child = spawnSync(process.execPath, [path.join(__dirname, '../src/main/mcp.js')], {
    encoding: 'utf8', input, env: { ...process.env, USERPROFILE: dir, HOME: dir }
  });
  assert.equal(child.status, 0, child.stderr);
  const results = new Map(child.stdout.trim().split('\n').map((line) => {
    const message = JSON.parse(line);
    return [message.id, message];
  }));
  assert.equal(results.get(0).result.protocolVersion, '2025-06-18');
  const [open, snapshot] = results.get(1).result.tools;
  assert.equal(open._meta.ui.resourceUri, uri);
  assert.deepEqual(open._meta['com.google.antigravity/ui'].entrypoints.map((entry) => entry.type), ['global', 'aux_pane']);
  assert.deepEqual(snapshot._meta.ui.visibility, ['app']);
  assert.equal(snapshot.annotations.readOnlyHint, true);
  const [page] = results.get(2).result.contents;
  assert.equal(page.mimeType, 'text/html;profile=mcp-app');
  assert.match(page.text, /ui\/notifications\/initialized/);
  assert.doesNotMatch(page.text, /data-demo="true"/);
  const data = results.get(3).result.structuredContent;
  assert.equal(data.usage.period, '7D');
  assert.equal(data.usage.heatmap.length, 30);
  assert.equal(data.sources.present, false);
  assert.equal(data.quota.online, false);
  assert.equal(results.get(4).error.code, -32002);
});
