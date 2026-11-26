'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { cli, isStopped } = require('./hud');

async function waitFor(predicate) {
  const deadline = Date.now() + 15000;
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

function reopen(exe, updated) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, updated ? ['--updated'] : [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore' });
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
  const logs = path.join(process.env.LOCALAPPDATA || os.homedir(), 'AGY Liquid Monitor');
  let report;
  try {
    report = await completeUpdate(plan, {
      awaitExit: (pid) => waitFor(() => exited(pid)),
      install: runInstaller,
      awaitClosed: (target) => waitFor(() => isStopped(target)),
      check: (target) => cli(['check', '--target', target]),
      repair: (target) => {
        const result = cli(['repair', '--target', target]);
        if (!result.repaired && !result.installed) throw new Error(result.reason);
        return result;
      },
      launch: async (target, updated) => {
        const exe = path.resolve(path.dirname(target), '../Antigravity.exe');
        if (fs.existsSync(exe) && isStopped(target)) await reopen(exe, updated);
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
