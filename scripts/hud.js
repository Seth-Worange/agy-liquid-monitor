'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const asar = require('./asar');
const platforms = { win32: require('./platforms/windows'), darwin: require('./platforms/macos') };

const root = path.resolve(__dirname, '..');
const prefix = 'dist/agy-liquid-monitor/';
const marker = prefix + 'installation.json';
const utils = 'dist/utils.js';
const preload = 'dist/preload.js';
const updater = 'dist/updater.js';
const allowedAnchor = /^([ \t]*)(?:void\s+)?loadHubWindowUrl\(\s*win\s*,\s*url(?:\s*,[^)\r\n]*)?\);[ \t]*(?=\r?$)/gm;

function hostVersion(target) {
  const pkg = JSON.parse(asar.extractAsarFile(target, 'package.json'));
  if (String(pkg.name).toLowerCase() !== 'antigravity' || !/^2\.\d+\.\d+$/.test(pkg.version)) {
    throw new Error('未识别到兼容的 Antigravity Desktop 2.x 归档。');
  }
  return pkg.version;
}

function patchFiles(source, platform = process.platform) {
  const original = asar.extractAsarFile(source, utils).toString('utf8');
  const hits = [...original.matchAll(allowedAnchor)];
  if (hits.length !== 1 || !original.includes('function getHubWebContents(')) {
    throw new Error('当前 Antigravity 构建的窗口结构不兼容。');
  }
  const [anchor] = hits;
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const line = anchor[1] + 'try { require("./agy-liquid-monitor/src/main/hud-bridge").attachHud(getHubWebContents(win), url); } catch {}' + eol;
  const newUtils = original.slice(0, anchor.index) + line + original.slice(anchor.index);
  const originalPreload = asar.extractAsarFile(source, preload).toString('utf8');
  if (!originalPreload.includes('const electron_1 = require("electron")')) {
    throw new Error('当前 Antigravity 构建的预加载结构不兼容。');
  }
  const newPreload = originalPreload + `
try {
  electron_1.contextBridge.exposeInIsolatedWorld(1009, "agyLiquidMonitor", {
    snapshot: (query) => electron_1.ipcRenderer.invoke("agy-liquid-monitor:snapshot", query),
    saveAppearance: (settings) => electron_1.ipcRenderer.invoke("agy-liquid-monitor:save-appearance", settings)
  });
} catch {}
`;
  const files = new Map([[utils, Buffer.from(newUtils)], [preload, Buffer.from(newPreload)]]);
  const updateEntry = asar.getAsarNode(asar.readAsarHeader(source).header, updater);
  const adapter = platforms[platform];
  if (adapter && updateEntry && !updateEntry.unpacked && !updateEntry.link) {
    const updateSource = asar.extractAsarFile(source, updater).toString('utf8');
    const matches = [...updateSource.matchAll(adapter.updateCall)];
    if (matches.length === 1 && updateSource.includes('function getLastState(')) {
      const next = updateSource.replace(adapter.updateCall, (_, indent) => indent +
        `require("./agy-liquid-monitor/src/platforms/${adapter.updateEntry}/update").quitAndInstall(updater, isSilent, ` +
        `${JSON.stringify(process.execPath)}, electron_1.app.getVersion(), getLastState().update?.version);`);
      files.set(updater, Buffer.from(next));
    }
  }
  for (const [file, data] of files) new vm.Script(data.toString('utf8'), { filename: file });
  return files;
}

function getBackup(source, hash) {
  return path.join(path.dirname(source), `app.asar.agy-liquid-monitor.${hash}.original`);
}

function archiveReader(file) {
  const { header, baseOffset } = asar.readAsarHeader(file);
  const bytes = fs.readFileSync(file);
  return {
    header,
    read(name) {
      const entry = asar.getAsarNode(header, name);
      const start = baseOffset + Number(entry.offset);
      const end = start + entry.size;
      assert.ok(start >= baseOffset && end <= bytes.length, name);
      return bytes.subarray(start, end);
    }
  };
}

function stage(source, dest, versionOfHost, originalHash, platform = process.platform) {
  const replacements = patchFiles(source, platform);
  const additions = new Map();
  const addFiles = (directory) => {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const relative = directory + '/' + entry.name;
      if (entry.isDirectory()) addFiles(relative);
      else if (entry.isFile()) additions.set(prefix + relative, fs.readFileSync(path.join(root, relative)));
    }
  };
  addFiles('src');
  const { version } = require('../package.json');
  const updateHandoff = replacements.has(updater);
  if (updateHandoff) {
    addFiles('scripts/platforms');
    for (const name of ['scripts/asar.js', 'scripts/hud.js', 'scripts/update-worker.js']) {
      additions.set(prefix + name, fs.readFileSync(path.join(root, name)));
    }
    additions.set(prefix + 'package.json', Buffer.from(JSON.stringify({ version })));
  }
  additions.set(marker, Buffer.from(JSON.stringify({ version, hostVersion: versionOfHost, originalHash, updateHandoff })));
  const base = archiveReader(source);
  if (asar.getAsarNode(base.header, marker) || asar.getAsarNode(base.header, 'dist/ag-vario') || asar.getAsarNode(base.header, 'dist/meter-main.js')) {
    throw new Error('已检测到其他监控补丁，请使用原始 Antigravity 安装。');
  }
  const { fileSha256 } = asar.repackAsarWithOverlay(source, dest, { replacements, additions });
  const packed = archiveReader(dest);
  const output = new Map(asar.listAsarFiles(dest).map((entry) => [entry.path, entry]));
  const original = asar.listAsarFiles(source);
  assert.equal(output.size, original.length + additions.size, 'Unexpected ASAR file count');
  for (const file of original) {
    const next = output.get(file.path);
    assert.ok(next && next.unpacked === file.unpacked && next.link === file.link && next.executable === file.executable, file.path);
    if (file.unpacked || file.link) continue;
    const expected = replacements.get(file.path) || base.read(file.path);
    assert.ok(expected.equals(packed.read(file.path)), file.path);
  }
  for (const [name, bytes] of additions) assert.ok(bytes.equals(packed.read(name)), name);
  return fileSha256;
}

function installedInfo(target) {
  if (!asar.getAsarNode(asar.readAsarHeader(target).header, marker)) return null;
  const info = JSON.parse(asar.extractAsarFile(target, marker));
  if (!/^[0-9a-f]{64}$/.test(info.originalHash)) throw new Error('原始安装校验记录损坏。');
  return info;
}

function isStopped(target) {
  return platforms[process.platform].isStopped(target);
}

function assertStopped(target) {
  if (!isStopped(target)) {
    throw new Error('请先从托盘或 Antigravity 菜单完全退出，再运行安装或还原。');
  }
}

function withArchiveLock(prefix, handler) {
  const lock = prefix + '.agy-liquid-monitor.lock';
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const fd = fs.openSync(lock, 'wx');
  try {
    return handler();
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}

function cli(args) {
  const [command, ...flags] = args;
  if (!['check', 'stage', 'install', 'restore', 'repair'].includes(command)) {
    throw new Error('用法: node scripts/hud.js check|stage|install|restore|repair [--target <resources/app.asar>] [--output <file>]');
  }
  const options = {};
  for (let i = 0; i < flags.length; i += 2) {
    if (!['--target', '--output'].includes(flags[i]) || !flags[i + 1]) throw new Error('安装参数无效。');
    options[flags[i]] = flags[i + 1];
  }
  const adapter = platforms[process.platform];
  if (!adapter) throw new Error('此安装器支持 Windows 和 macOS。');
  const specified = options['--target'] || adapter.detectTarget();
  if (!specified) throw new Error('找不到 Antigravity，请通过 --target 指定 app.asar。');
  const target = fs.realpathSync(path.resolve(specified));
  if (path.basename(target).toLowerCase() !== 'app.asar' || path.basename(path.dirname(target)).toLowerCase() !== 'resources') {
    throw new Error('--target 应指向 Antigravity 的 Resources/app.asar。');
  }
  adapter.validateTarget?.(target);
  const repair = command === 'repair';
  if (repair) {
    const installed = installedInfo(target);
    if (installed) return { target, installed: installed.version, repaired: false };
    if (!isStopped(target)) return { target, repaired: false, reason: '客户端正在运行' };
  }
  const versionOfHost = hostVersion(target);
  if (command !== 'restore') adapter.assertCompatible(target);
  if (command === 'check') {
    const installed = installedInfo(target);
    if (!installed) adapter.verifyOriginal?.(target);
    const updateHandoff = installed ? installed.updateHandoff === true : patchFiles(target).has(updater);
    return { target, hostVersion: versionOfHost, installed: installed?.version || null, compatible: true, updateHandoff };
  }
  if (command === 'stage') {
    adapter.verifyOriginal?.(target);
    if (!options['--output']) throw new Error('stage 需要 --output。');
    const output = path.resolve(options['--output']);
    if (fs.existsSync(output)) throw new Error('输出路径已经存在。');
    return { output, hostVersion: versionOfHost, sha256: stage(target, output, versionOfHost, asar.sha256File(target)) };
  }
  assertStopped(target);
  const receiptPrefix = adapter.receiptPrefix(target);
  return withArchiveLock(receiptPrefix, () => {
    const installed = installedInfo(target);
    if (repair && installed) return { target, installed: installed.version, repaired: false };
    const before = asar.sha256File(target);
    const originalHash = installed?.originalHash || before;
    const backup = getBackup(receiptPrefix, originalHash);
    if (command === 'restore' && !installed) return { target, hostVersion: versionOfHost, restored: false };
    if (!installed) adapter.verifyOriginal?.(target);
    if (!installed && !fs.existsSync(backup)) fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
    if (asar.sha256File(backup) !== originalHash) throw new Error('原始归档备份校验失败。');
    if (installed && !fs.existsSync(receiptPrefix + `.agy-installed-${before}`)) {
      throw new Error('当前归档与本插件的安装记录不匹配。');
    }
    if (command === 'restore') {
      assertStopped(target);
      if (asar.sha256File(target) !== before) throw new Error('Antigravity 归档在操作中发生变化。');
      asar.atomicReplaceFile(backup, target, originalHash);
      adapter.verifyOriginal?.(target);
      return { target, hostVersion: versionOfHost, restored: true };
    }
    const staging = target + `.agy-stage-${randomUUID()}`;
    try {
      const hash = stage(backup, staging, versionOfHost, originalHash);
      const receipt = receiptPrefix + `.agy-installed-${hash}`;
      if (!fs.existsSync(receipt)) fs.writeFileSync(receipt, originalHash, { flag: 'wx' });
      assertStopped(target);
      if (asar.sha256File(target) !== before) throw new Error('Antigravity 归档在操作中发生变化。');
      fs.renameSync(staging, target);
      return { target, hostVersion: versionOfHost, sha256: hash, ...(repair ? { repaired: true } : {}) };
    } finally {
      if (fs.existsSync(staging)) fs.unlinkSync(staging);
    }
  });
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(cli(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { cli, hostVersion, isStopped, patchFiles, stage };
