'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { renderPage } = require('../src/main/page');
const { hudSource } = require('../src/main/ui-source');
const { demoData } = require('./demo');
const manifest = require('../plugin.json');
const { version } = require('../package.json');
const root = path.resolve(__dirname, '..');

if (manifest.version !== version) throw new Error('Plugin and package versions must match');
const output = path.join(root, 'dist');
const plugin = path.join(output, manifest.name);
fs.mkdirSync(plugin, { recursive: true });
for (const name of ['src', 'scripts', 'docs', 'plugin.json', 'mcp_config.json', 'package.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
  fs.cpSync(path.join(root, name), path.join(plugin, name), { recursive: true });
}
fs.writeFileSync(path.join(output, 'dashboard.html'), renderPage({ demo: true }), 'utf8');
const preview = fs.readFileSync(path.join(root, 'src/ui/hud-preview.html'), 'utf8')
  .replace('/* FIXTURE */', () => JSON.stringify(demoData()).replaceAll('<', '\\u003c'))
  .replace('/* HUD */', () => hudSource());
fs.writeFileSync(path.join(output, 'preview.html'), preview, 'utf8');
console.log(`Windows HUD & MCP package: ${plugin}\nBrowser HUD demo: ${path.join(output, 'preview.html')}`);
