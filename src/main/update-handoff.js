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
    // This snapshot must survive replacement of the running application's ASAR.
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

function quitAndInstall(updater, silent, node, fromVersion, toVersion, launchWorker = startWorker) {
  const installer = updater.installerPath;
  const original = updater.spawnLog;
  if (updater.constructor.name !== 'NsisUpdater' || !installer || !path.isAbsolute(installer) ||
    typeof original !== 'function' || updater.downloadedUpdateHelper?.downloadedFileInfo?.isAdminRightsRequired ||
    !/^2\.\d+\.\d+$/.test(toVersion) || fromVersion === toVersion) {
    return updater.quitAndInstall(silent, true);
  }

  // NSIS invokes spawnLog synchronously while preparing the official installer.
  const ownSpawnLog = Object.hasOwn(updater, 'spawnLog');
  updater.spawnLog = function (command, args, ...options) {
    if (command === installer && args.includes('--updated') && args.includes('--force-run')) {
      try {
        const plan = {
          installer,
          // NSIS does not auto-launch in silent mode unless --force-run is present.
          args: ['/S', ...args.filter((arg) => arg !== '--force-run' && arg !== '/S')],
          target: path.join(path.dirname(process.execPath), 'resources', 'app.asar'),
          parentPid: process.pid,
          fromVersion,
          toVersion
        };
        if (launchWorker(node, plan)) return Promise.resolve(true);
      } catch (error) {
        console.warn('[Liquid Monitor] Cannot prepare update handoff:', error.message);
      }
    }
    return original.call(this, command, args, ...options);
  };
  try {
    return updater.quitAndInstall(silent, true);
  } finally {
    if (ownSpawnLog) updater.spawnLog = original;
    else delete updater.spawnLog;
  }
}

module.exports = { quitAndInstall };
