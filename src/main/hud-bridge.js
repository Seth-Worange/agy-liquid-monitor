'use strict';

const { ipcMain } = require('electron');
const { createMonitor } = require('./monitor');
const { hudSource } = require('./ui-source');
const { saveAppearance } = require('./preferences');

const channel = 'agy-liquid-monitor:snapshot';
const windows = new WeakMap();
let monitor;
let source;

function originOf(url) {
  try {
    const { origin, hostname, protocol, port } = new URL(url);
    return hostname === '127.0.0.1' && port && ['http:', 'https:'].includes(protocol) ? origin : null;
  } catch {
    return null;
  }
}

function assertMonitorFrame(event) {
  const { sender, senderFrame } = event;
  if (!senderFrame || senderFrame !== sender.mainFrame || !originOf(senderFrame.url) ||
    windows.get(sender) !== originOf(senderFrame.url)) {
    throw new Error('Liquid Monitor accepts only its Antigravity main frame');
  }
}

ipcMain.handle('agy-liquid-monitor:save-appearance', (event, settings) => {
  assertMonitorFrame(event);
  return saveAppearance(settings);
});

ipcMain.handle(channel, (event, params) => {
  assertMonitorFrame(event);
  const query = {
    ids: Array.isArray(params?.ids) ? params.ids.slice(0, 4) : [],
    currentModel: typeof params?.currentModel === 'string' ? params.currentModel.slice(0, 120) : null,
    period: params?.period,
    date: params?.date,
    context: params?.context === true,
    force: params?.force === true,
    fallback: false
  };
  monitor ||= createMonitor();
  return monitor.snapshot(query);
});

function attachHud(contents, targetUrl) {
  const origin = originOf(targetUrl);
  if (!contents || !origin || contents.isDestroyed()) return;
  const first = !windows.has(contents);
  windows.set(contents, origin);
  if (!first) return;
  contents.on('dom-ready', () => {
    if (contents.isDestroyed() || windows.get(contents) !== originOf(contents.getURL())) return;
    source ||= hudSource();
    void contents.executeJavaScriptInIsolatedWorld(1009, [{ code: source }]).catch(() => {});
  });
}

module.exports = { attachHud };
