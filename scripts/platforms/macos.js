'use strict';

const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assertAsarIntegrityDisabled } = require('./electron-fuses');

const bundle = (target) => path.resolve(path.dirname(target), '../..');
const appTarget = (app) => path.join(app, 'Contents', 'Resources', 'app.asar');
const executable = (target) => path.join(bundle(target), 'Contents', 'MacOS', 'Antigravity');
const stateDir = () => path.join(os.homedir(), 'Library', 'Application Support', 'AGY Liquid Monitor');

function detectTarget() {
  return ['/Applications/Antigravity.app', path.join(os.homedir(), 'Applications', 'Antigravity.app')]
    .map(appTarget).find(fs.existsSync);
}

function validateTarget(target) {
  const app = bundle(target);
  if (!app.endsWith('.app') || appTarget(app) !== target || !fs.existsSync(executable(target))) {
    throw new Error('--target 应指向 Antigravity.app/Contents/Resources/app.asar。');
  }
}

function assertCompatible(target) {
  const framework = path.join(bundle(target), 'Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework');
  // Electron stores the fuses in its framework on macOS, including each universal slice.
  assertAsarIntegrityDisabled(framework, true);
}

function verifyOriginal(target) {
  try {
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle(target)],
      { timeout: 30000, stdio: 'ignore' });
  } catch {
    throw new Error('原始 Antigravity 应用签名校验失败。请先恢复原版归档或从官方重新安装。');
  }
}

function isStopped(target) {
  const exe = fs.realpathSync(executable(target));
  const processes = execFileSync('/bin/ps', ['-axww', '-o', 'comm='], { encoding: 'utf8', timeout: 5000 });
  const contents = path.join(bundle(target), 'Contents');
  return !processes.split('\n').some((line) => {
    const command = line.trim();
    return command === exe || command === 'Antigravity' ||
      command.startsWith('Antigravity Helper') || command.startsWith(contents + path.sep);
  });
}

function receiptPrefix(target) {
  const key = createHash('sha256').update(target).digest('hex').slice(0, 24);
  return path.join(stateDir(), 'backups', key, 'app.asar');
}

function openUpdatedApp(target) {
  execFileSync('/usr/bin/open', [bundle(target), '--args', '--updated'], { timeout: 15000, stdio: 'ignore' });
}

// The macOS case is the call immediately after the Windows branch's return.
const updateCall = /(?<=        return;\r?\n    }\r?\n)([ \t]+)electron_updater_1\.autoUpdater\.quitAndInstall\(isSilent, true\);(?=\r?\n})/g;

module.exports = {
  detectTarget, validateTarget, assertCompatible, verifyOriginal, isStopped, receiptPrefix,
  executable, bundle, stateDir, openUpdatedApp, updateCall, updateEntry: 'macos'
};
