'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assertAsarIntegrityDisabled } = require('./electron-fuses');

const executable = (target) => path.resolve(path.dirname(target), '../Antigravity.exe');

function detectTarget() {
  const dirs = [process.env.LOCALAPPDATA, path.join(os.homedir(), 'AppData', 'Local')].filter(Boolean)
    .map((dir) => path.join(dir, 'Programs', 'Antigravity'));
  if (process.env.ProgramFiles) dirs.push(path.join(process.env.ProgramFiles, 'Antigravity'));
  return dirs.map((dir) => path.join(dir, 'resources', 'app.asar')).find(fs.existsSync);
}

function isStopped(target) {
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const code = '$ErrorActionPreference = "Stop"; Get-CimInstance Win32_Process -Filter "Name = \'Antigravity.exe\'" | ' +
    'ForEach-Object { if ($_.ExecutablePath) { $_.ExecutablePath } else { "UNKNOWN" } }';
  const rows = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', code],
    { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim().split(/\r?\n/);
  const exe = fs.realpathSync(executable(target)).toLowerCase();
  return !rows.some((row) => row === 'UNKNOWN' || row.trim().toLowerCase() === exe);
}

const updateCall = /^([ \t]*)electron_updater_1\.autoUpdater\.quitAndInstall\(isSilent, true\);(?=\r?\n[ \t]+launched = Boolean\(updater\.quitAndInstallCalled\);)/gm;

module.exports = {
  detectTarget, isStopped, executable, updateCall,
  updateEntry: 'windows',
  assertCompatible: (target) => assertAsarIntegrityDisabled(executable(target)),
  receiptPrefix: (target) => target
};
