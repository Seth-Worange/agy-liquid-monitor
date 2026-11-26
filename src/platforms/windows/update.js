'use strict';

const path = require('node:path');
const { startWorker } = require('../update-snapshot');

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
