'use strict';

const $ = (selector) => document.querySelector(selector);
const clock = new Intl.DateTimeFormat('zh-CN', {timeStyle: 'short'});
const systemTheme = matchMedia('(prefers-color-scheme: light)');
const demo = document.body.dataset.demo === 'true';
const framed = window.parent !== window;
const content = $('#content');
let state = { view: 'overview', period: '30D', date: null, ids: [] };
let result = null;
let hostTheme = null;
let busy = false;
let refreshPending = false;
let forcePending = false;
let hostConnected = false;

const { overview, sessionView, sessionDetail, contextDetail, agentDetail, quotaView, usageView, escape } = createMonitorViews(state);

const appearance = createAppearance(applyTheme);
const appearanceButton = $('#appearance');
const appearancePanel = $('#appearance-panel');
appearanceButton.querySelector('svg').innerHTML = appearance.icon;
appearancePanel.innerHTML = appearance.markup;
appearance.bind(appearancePanel);

function applyTheme() {
  appearance.apply(document.documentElement, hostTheme || (systemTheme.matches ? 'light' : 'dark'));
}
function applyHostContext(hostContext = {}) {
  if (hostContext.theme === 'light' || hostContext.theme === 'dark') hostTheme = hostContext.theme;
  const hostFont = hostContext.styles?.variables?.['--font-sans'];
  if (typeof hostFont === 'string') document.documentElement.style.setProperty('--agy-ui-font', hostFont);
  applyTheme();
}
systemTheme.addEventListener('change', applyTheme);
applyTheme();

let nextId = 1;
const pending = new Map();
function notify(method, params = {}) {
  window.parent.postMessage({ jsonrpc: '2.0', method, params }, '*');
}
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Antigravity 响应超时。'));
    }, 16000);
    pending.set(id, { resolve, reject, timeout });
    window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
  });
}
window.addEventListener('message', (event) => {
  if (event.source !== window.parent || event.data?.jsonrpc !== '2.0') return;
  const message = event.data;
  if (message.method === 'ui/notifications/host-context-changed') {
    applyHostContext(message.params);
  }
  if (message.method === 'ui/resource-teardown' && message.id != null) {
    window.parent.postMessage({ jsonrpc: '2.0', id: message.id, result: {} }, '*');
  }
  if (message.method || !pending.has(message.id)) return;
  const waiter = pending.get(message.id);
  pending.delete(message.id);
  clearTimeout(waiter.timeout);
  if (message.error) waiter.reject(new Error(message.error.message));
  else waiter.resolve(message.result);
});

function connection(label, status) {
  $('#connection').textContent = label;
  $('#connection').dataset.state = status;
}

function render(data) {
  const views = {
    overview: () => overview(data),
    session: () => sessionView(data, sessionDetail),
    context: () => sessionView(data, contextDetail),
    agents: () => sessionView(data, agentDetail),
    quota: () => quotaView(data.quota),
    usage: () => usageView(data.usage, data.quota.profile)
  };
  content.innerHTML = views[state.view]();
  if (hostConnected) notify('ui/notifications/size-changed', { height: document.documentElement.scrollHeight });
}

async function readData(query) {
  if (demo) return window.monitorDemo(query);
  if (!framed) throw new Error('请从 Antigravity 插件菜单打开看板，或运行 npm run preview。');
  if (!hostConnected) {
    const init = await request('ui/initialize', {
      appInfo: { name: 'AGY Liquid Monitor', version: '0.2.4' },
      appCapabilities: {}, protocolVersion: '2026-01-26'
    });
    applyHostContext(init?.hostContext);
    hostConnected = true;
    notify('ui/notifications/initialized');
  }
  const response = await request('tools/call', { name: 'monitor_snapshot', arguments: query });
  if (response?.isError || !response?.structuredContent) throw new Error('暂时无法读取本地用量。请刷新重试。');
  return response.structuredContent;
}

async function refresh(force = false) {
  if (busy) {
    refreshPending = true;
    forcePending ||= force;
    return;
  }
  busy = true;
  content.setAttribute('aria-busy', 'true');
  const query = { ids: state.ids, period: state.view === 'overview' ? '30D' : state.period,
    date: state.view === 'usage' ? state.date : null, context: state.view === 'context', force };
  try {
    const data = await readData(query);
    if (refreshPending) return;
    result = data;
    state.ids = data.panels.map((panel) => panel.main.conversationId);
    render(data);
    if (demo) connection('演示数据', 'demo');
    else if (data.quota.online) connection('已连接', 'online');
    else connection(data.sources.present ? '本地记录' : '无本地记录', 'offline');
    $('#source').textContent = demo ? '数据来源 · 演示样本' :
      `数据来源 · ${data.sources.databases} 个本地会话库${data.sources.errors ? ` · ${data.sources.errors} 个读取失败` : ''}`;
    $('#updated').textContent = `更新于 ${clock.format(data.updatedAt)}`;
    $('#updated').dateTime = new Date(data.updatedAt).toISOString();
  } catch (error) {
    connection('读取失败', 'error');
    if (!result) content.innerHTML = `<section class="surface empty">${escape(error.message)}</section>`;
  } finally {
    content.setAttribute('aria-busy', 'false');
    busy = false;
    if (refreshPending) {
      const nextForce = forcePending;
      refreshPending = forcePending = false;
      void refresh(nextForce);
    }
  }
}

function go(view) {
  state.view = view;
  for (const button of document.querySelectorAll('[data-view]')) {
    const selected = button.dataset.view === view;
    button.classList.toggle('selected', selected);
    if (selected) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  if (result) render(result);
  void refresh();
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  const { view, go: destination, date, period, remove } = button.dataset;
  if (view || destination) go(view || destination);
  if (date) {
    state.date = state.date === date ? null : date;
    go('usage');
  }
  if (period || button.hasAttribute('data-clear')) {
    state.period = period || state.period;
    state.date = null;
    void refresh();
  }
  if (remove) {
    state.ids = state.ids.filter((id) => id !== remove);
    void refresh();
  }
  if (button.id === 'refresh') void refresh(true);
  if (button === appearanceButton) {
    appearancePanel.hidden = !appearancePanel.hidden;
    appearanceButton.setAttribute('aria-expanded', String(!appearancePanel.hidden));
    if (hostConnected) notify('ui/notifications/size-changed', { height: document.documentElement.scrollHeight });
  }
});

appearancePanel.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && appearance.closeThemeMenu(appearancePanel)) event.stopPropagation();
});

content.addEventListener('change', (event) => {
  const { id, value } = event.target;
  if (id === 'session-select') state.ids = [value, ...state.ids.slice(1).filter((item) => item !== value)];
  if (id === 'compare' && value && state.ids.length < 4) state.ids = [...state.ids, value];
  void refresh();
});

setInterval(() => {
  if (!demo && !document.hidden && hostConnected && document.hasFocus() && !content.contains(document.activeElement)) {
    void refresh();
  }
}, 20000);
void refresh();
