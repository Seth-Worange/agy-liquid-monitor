'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const test = require('node:test');
const { quitAndInstall } = require('../src/platforms/windows/update');
const { quitAndInstall: quitAndInstallMac } = require('../src/platforms/macos/update');
const { completeUpdate } = require('../scripts/update-worker');

class NsisUpdater {
  installerPath = path.resolve('Antigravity-x64.exe');
  args = ['--updated', '--force-run', '--package-file=payload.7z'];
  spawned = [];

  quitAndInstall(silent, restart) {
    this.options = [silent, restart];
    return this.spawnLog(this.installerPath, this.args);
  }

  spawnLog(command, args) {
    this.spawned.push({ command, args });
  }
}

test('handoff preserves official update arguments and suppresses only its auto launch', async () => {
  const updater = new NsisUpdater();
  let plan;
  await quitAndInstall(updater, false, process.execPath, '2.35.2', '2.35.3', (_, data) => {
    plan = data;
    return true;
  });
  assert.equal(plan.installer, updater.installerPath);
  assert.deepEqual(plan.args, ['/S', '--updated', '--package-file=payload.7z']);
  assert.deepEqual(updater.options, [false, true]);
  assert.deepEqual(updater.spawned, []);
  assert.equal(Object.hasOwn(updater, 'spawnLog'), false);
});

test('failure to start the helper leaves the original update and restart intact', async () => {
  const updater = new NsisUpdater();
  await quitAndInstall(updater, false, process.execPath, '2.35.2', '2.35.3', () => false);
  assert.deepEqual(updater.spawned, [{ command: updater.installerPath, args: updater.args }]);
});

class MacUpdater {
  nativeUpdater = new EventEmitter();
  autoRunAppAfterInstall = true;
  restarts = [];

  quitAndInstall() {
    this.nativeUpdater.once('update-downloaded', () => this.handleUpdateDownloaded());
  }

  handleUpdateDownloaded() {
    this.restarts.push(this.autoRunAppAfterInstall);
  }
}

test('macOS delegates one restart only after Squirrel has staged the official update', () => {
  const updater = new MacUpdater();
  const plans = [];
  const services = {
    resourcesPath: path.join('/Applications', 'Antigravity.app', 'Contents', 'Resources'),
    launchWorker: (_, plan) => { plans.push(plan); return true; }
  };
  quitAndInstallMac(updater, false, process.execPath, '2.35.2', '2.35.3', services);
  quitAndInstallMac(updater, false, process.execPath, '2.35.2', '2.35.3', services);
  assert.equal(plans.length, 0);
  assert.deepEqual(updater.restarts, []);
  updater.nativeUpdater.emit('update-downloaded');
  assert.equal(plans.length, 1);
  assert.equal(plans[0].target, path.join(services.resourcesPath, 'app.asar'));
  assert.deepEqual(updater.restarts, [false]);
  assert.equal(updater.autoRunAppAfterInstall, true);
  assert.equal(Object.hasOwn(updater, 'handleUpdateDownloaded'), false);
});

test('macOS keeps the official relaunch if the helper is unavailable', () => {
  const updater = new MacUpdater();
  quitAndInstallMac(updater, false, process.execPath, '2.35.2', '2.35.3', {
    resourcesPath: '/Applications/Antigravity.app/Contents/Resources',
    launchWorker: () => false
  });
  updater.nativeUpdater.emit('update-downloaded');
  assert.deepEqual(updater.restarts, [true]);
});

test('the helper waits for the official installer before touching the new archive and then reopens', async () => {
  const order = [];
  const plan = { fromVersion: '2.35.2', toVersion: '2.35.3' };
  let finishInstall;
  const install = new Promise((resolve) => { finishInstall = resolve; });
  const result = completeUpdate(plan, {
    awaitExit: async () => { order.push('quit'); return true; },
    install: () => { order.push('install'); return install; },
    awaitClosed: async () => true,
    check: () => { order.push('check'); return { hostVersion: plan.toVersion }; },
    repair: () => { order.push('repair'); return { repaired: true }; },
    launch: async (_, updated) => { assert.equal(updated, true); order.push('launch'); }
  });
  await Promise.resolve();
  assert.deepEqual(order, ['quit', 'install']);
  finishInstall();
  await result;
  assert.deepEqual(order, ['quit', 'install', 'check', 'repair', 'launch']);
});

test('incompatible or incomplete official updates reopen without patching', async () => {
  for (const installerFails of [true, false]) {
    const message = installerFails ? 'installer failed' : 'incompatible archive';
    let reopened = false;
    await assert.rejects(completeUpdate({}, {
      awaitExit: async () => true,
      install: async () => { if (installerFails) throw new Error(message); },
      awaitClosed: async () => true,
      check: () => { throw new Error(message); },
      repair: () => { assert.fail('must not patch the archive'); },
      launch: async (_, updated) => { assert.equal(updated, !installerFails); reopened = true; }
    }), { message });
    assert.ok(reopened);
  }
});
