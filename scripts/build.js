'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { renderPage } = require('../src/main/page');
const manifest = require('../plugin.json');
const { version } = require('../package.json');
const root = path.resolve(__dirname, '..');

if (manifest.version !== version) throw new Error('Plugin and package versions must match');
const output = path.join(root, 'dist');
const plugin = path.join(output, manifest.name);
fs.mkdirSync(plugin, { recursive: true });
for (const name of ['src', 'plugin.json', 'mcp_config.json', 'package.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
  fs.cpSync(path.join(root, name), path.join(plugin, name), { recursive: true });
}
fs.writeFileSync(path.join(output, 'preview.html'), renderPage({ demo: true }), 'utf8');
console.log(`Antigravity plugin: ${plugin}\nBrowser demo: ${path.join(output, 'preview.html')}`);
