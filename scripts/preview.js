'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
require('./build');

if (process.platform === 'win32' || process.platform === 'darwin') {
  const preview = path.resolve(__dirname, '../dist/preview.html');
  const command = process.platform === 'darwin' ? '/usr/bin/open' : 'explorer.exe';
  const child = spawn(command, [preview], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => console.error(`Open this file in a browser: ${preview}`));
  child.unref();
}
