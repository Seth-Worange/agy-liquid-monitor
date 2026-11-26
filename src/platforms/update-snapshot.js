'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function copyDirectory(source, target) {
  fs.mkdirSync(target);
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else if (entry.isFile()) fs.writeFileSync(to, fs.readFileSync(from));
  }
}

function startWorker(node, plan) {
  const source = path.resolve(__dirname, '../..');
  fs.accessSync(node, fs.constants.X_OK);
  fs.accessSync(path.dirname(plan.target), fs.constants.W_OK);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-liquid-update-'));
  let launched = false;
  try {
    // The snapshot must survive replacement of the running application's ASAR.
    for (const name of ['src', 'scripts']) {
      copyDirectory(path.join(source, name), path.join(work, name));
    }
    fs.writeFileSync(path.join(work, 'package.json'), fs.readFileSync(path.join(source, 'package.json')));
    const child = spawn(node, [path.join(work, 'scripts', 'update-worker.js'), JSON.stringify(plan)],
      { cwd: work, detached: true, windowsHide: true, stdio: 'ignore' });
    child.on('error', () => {});
    if (!child.pid) return false;
    launched = true;
    child.unref();
    return true;
  } finally {
    if (!launched) fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = { startWorker };
