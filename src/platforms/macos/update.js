'use strict';

const path = require('node:path');
const { startWorker } = require('../update-snapshot');

const pending = new WeakSet();

function quitAndInstall(updater, silent, node, fromVersion, toVersion, services = {}) {
  const { launchWorker = startWorker, resourcesPath = process.resourcesPath } = services;
  const original = updater.handleUpdateDownloaded;
  if (updater.constructor.name !== 'MacUpdater' || typeof original !== 'function' ||
    !resourcesPath || !/^2\.\d+\.\d+$/.test(toVersion) || fromVersion === toVersion) {
    return updater.quitAndInstall(silent, true);
  }
  if (pending.has(updater)) return;

  // Wait for Squirrel to finish staging the official update before delegating the restart.
  const ownHandler = Object.hasOwn(updater, 'handleUpdateDownloaded');
  let timer;
  function restore() {
    clearTimeout(timer);
    updater.nativeUpdater?.removeListener('error', restore);
    if (ownHandler) updater.handleUpdateDownloaded = original;
    else delete updater.handleUpdateDownloaded;
    pending.delete(updater);
  }
  pending.add(updater);
  updater.nativeUpdater?.once('error', restore);
  timer = setTimeout(restore, 120000);
  timer.unref();
  updater.handleUpdateDownloaded = function () {
    restore();
    let managed = false;
    try {
      managed = launchWorker(node, {
        target: path.join(resourcesPath, 'app.asar'), parentPid: process.pid, fromVersion, toVersion
      });
    } catch (error) {
      console.warn('[Liquid Monitor] Cannot prepare update handoff:', error.message);
    }
    const autoRun = updater.autoRunAppAfterInstall;
    if (managed) updater.autoRunAppAfterInstall = false;
    try {
      return original.call(this);
    } finally {
      updater.autoRunAppAfterInstall = autoRun;
    }
  };
  try {
    return updater.quitAndInstall(silent, true);
  } catch (error) {
    restore();
    throw error;
  }
}

module.exports = { quitAndInstall };
