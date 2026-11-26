'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { cli, hostVersion, isStopped } = require('./hud');
const macos = require('./platforms/macos');
const windows = require('./platforms/windows');

async function waitFor(predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  do {
    if (predicate()) return true;
    await delay(300);
  } while (Date.now() < deadline);
  return false;
}

function exited(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

function runInstaller(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: path.dirname(file), windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`官方安装器退出代码：${code}`)));
  });
}

async function waitForMacUpdate(plan) {
  let previous;
  let stableAt = 0;
  const installed = await waitFor(() => {
    try {
      const stat = fs.statSync(plan.target);
      const fingerprint = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
      if (hostVersion(plan.target) !== plan.toVersion) return false;
      if (fingerprint !== previous) {
        previous = fingerprint;
        stableAt = Date.now();
      }
      return Date.now() - stableAt >= 1000;
    } catch {
      // The updater can temporarily remove the old bundle while installing.
      previous = null;
      return false;
    }
  }, 120000);
  if (!installed) throw new Error('未能确认 macOS 官方更新已安装。请等待 Antigravity 更新结束后手动打开。');
}

function reopen(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

async function completeUpdate(plan, services) {
  const { awaitExit, install, awaitClosed, check, repair, launch } = services;
  if (!await awaitExit(plan.parentPid)) throw new Error('Antigravity 未退出，更新未开始。');
  let updated = false;
  try {
    await install(plan.installer, plan.args);
    updated = true;
    if (!await awaitClosed(plan.target)) throw new Error('Antigravity 正在运行，已跳过状态栏重装。');
    const version = check(plan.target).hostVersion;
    if (version === plan.fromVersion || version !== plan.toVersion) {
      throw new Error(`安装后的版本为 ${version}，预期为 ${plan.toVersion}。已跳过状态栏重装。`);
    }
    const result = repair(plan.target);
    return `状态栏已就绪，Antigravity ${version}，插件 ${result.installed || require('../package.json').version}。`;
  } finally {
    await launch(plan.target, updated);
  }
}

async function main(plan) {
  const work = path.resolve(__dirname, '..');
  const mac = process.platform === 'darwin';
  const logs = mac ? macos.stateDir() : path.join(process.env.LOCALAPPDATA || os.homedir(), 'AGY Liquid Monitor');
  let report;
  let repaired = false;
  try {
    report = await completeUpdate(plan, {
      awaitExit: (pid) => waitFor(() => exited(pid)),
      install: mac ? () => waitForMacUpdate(plan) : runInstaller,
      awaitClosed: (target) => waitFor(() => isStopped(target)),
      check: (target) => cli(['check', '--target', target]),
      repair: (target) => {
        const result = cli(['repair', '--target', target]);
        if (!result.repaired && !result.installed) throw new Error(result.reason);
        repaired = result.repaired;
        return result;
      },
      launch: async (target, updated) => {
        if (mac) {
          if (updated && fs.existsSync(macos.bundle(target)) && isStopped(target)) {
            try {
              macos.openUpdatedApp(target);
            } catch (error) {
              if (!repaired || !isStopped(target)) throw error;
              cli(['restore', '--target', target]);
              macos.openUpdatedApp(target);
              throw new Error('macOS 无法打开带状态栏的新版应用。已恢复原始签名并重新打开 Antigravity。');
            }
          }
        } else {
          const exe = windows.executable(target);
          if (fs.existsSync(exe) && isStopped(target)) await reopen(exe, updated ? ['--updated'] : [], path.dirname(exe));
        }
      }
    });
  } catch (error) {
    report = error.message;
  } finally {
    try {
      fs.mkdirSync(logs, { recursive: true });
      fs.writeFileSync(path.join(logs, 'last-update.log'), `${new Date().toISOString()} ${report}\n`, 'utf8');
    } finally {
      if (path.dirname(work) === path.resolve(os.tmpdir()) && path.basename(work).startsWith('agy-liquid-update-')) {
        process.chdir(os.tmpdir());
        fs.rmSync(work, { recursive: true, force: true });
      }
    }
  }
}

if (require.main === module) {
  main(JSON.parse(process.argv[2])).catch((error) => console.error(error.message));
}

module.exports = { completeUpdate };
