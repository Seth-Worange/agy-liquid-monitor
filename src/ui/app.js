'use strict';

const $ = (selector) => document.querySelector(selector);
const systemTheme = matchMedia('(prefers-color-scheme: light)');
const demo = document.body.dataset.demo === 'true';
const framed = window.parent !== window;
const content = $('#content');
const state = { view: 'overview', period: '30D', date: null, heatPage: 0, ids: [], sessionSource: 'recent',
  orchestrationTurns: new Map() };
let result = null;
let hostTheme = null;
let hostConversationId = null;
let paneVisible = true;
let busy = false;
let refreshPending = false;
let forcePending = false;
let hostConnected = false;
let renderedLanguage;
let connectionState = { label: '连接中', status: 'offline' };

const appearance = createAppearance(applyTheme, demo ? null : async (settings) => {
  if (!hostConnected) throw new Error('Antigravity is not connected');
  const response = await request('tools/call', { name: 'monitor_save_appearance', arguments: settings });
  if (response?.isError || !response?.structuredContent) throw new Error('Cannot save appearance');
});
const { t } = appearance;
const { overview, sessionView, sessionDetail, contextDetail, agentDetail, quotaView, usageView, escape } =
  createMonitorViews(state, t, () => appearance.language);
const appearanceButton = $('#appearance');
const appearancePanel = $('#appearance-panel');
const refreshButton = $('#refresh');
const refreshFeedback = createRefreshFeedback(refreshButton, t, '刷新数据');
appearanceButton.querySelector('svg').innerHTML = appearance.icon;
appearancePanel.innerHTML = appearance.markup;
appearance.bind(appearancePanel);

function applyTheme() {
  appearance.apply(document.documentElement, hostTheme || (systemTheme.matches ? 'light' : 'dark'));
  if (renderedLanguage === appearance.language) return;
  renderedLanguage = appearance.language;
  localizeMonitorMarkup(document, t);
  connection(connectionState.label, connectionState.status);
  if (result) {
    render(result);
    renderDataSource(result);
  }
}
function applyHostContext(hostContext = {}) {
  if (hostContext?.theme === 'light' || hostContext?.theme === 'dark') hostTheme = hostContext.theme;
  const hostFont = hostContext?.styles?.variables?.['--font-sans'];
  if (typeof hostFont === 'string') document.documentElement.style.setProperty('--agy-ui-font', hostFont);
  applyTheme();
  followConversation(hostContext?.conversationId);
}
function followConversation(id) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/i.test(id) || id === hostConversationId) return;
  hostConversationId = id;
  if (state.sessionSource === 'manual') return;
  state.sessionSource = 'host';
  state.ids = [id];
  if (hostConnected) void refresh();
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
  if (message.method === 'ui/notifications/tool-input') followConversation(message.params?.arguments?.conversationId);
  if (message.method === 'ui/notifications/tool-result') followConversation(message.params?.structuredContent?.conversationId);
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
  connectionState = { label, status };
  const node = $('#connection');
  const translated = t(label);
  if (node.textContent !== translated) node.textContent = translated;
  if (node.dataset.state !== status) node.dataset.state = status;
  node.title = status === 'stale' && result ? t('保留上次数据 · {0}', formatTime(result.updatedAt)) : translated;
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat(appearance.language, { timeStyle: 'short' }).format(timestamp);
}

function renderDataSource(data) {
  const failures = data.sources?.errors;
  $('#source').textContent = demo ? t('数据来源 · 演示样本') :
    t('数据来源 · {0} 个本地会话库', data.sources.databases) + (failures ? ' · ' + t('{0} 个读取失败', failures) : '');
  $('#updated').textContent = t('更新于 {0}', formatTime(data.updatedAt));
  $('#updated').dateTime = new Date(data.updatedAt).toISOString();
}

function showContent(html) {
  renderWithFocus(content, html, () => $('#session-select') || content.querySelector('[aria-pressed="true"]') ||
    content.querySelector('.heat-cell[tabindex="0"]') || $('.nav [aria-current="page"]'));
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
  showContent(views[state.view]());
  if (hostConnected) notify('ui/notifications/size-changed', { height: document.documentElement.scrollHeight });
}

async function readData(force) {
  if (!demo && !framed) throw new Error('请从 Antigravity 插件菜单打开看板，或运行 npm run preview。');
  if (!demo && !hostConnected) {
    const init = await request('ui/initialize', {
      appInfo: { name: 'AGY Liquid Monitor', version: '0.3.7' },
      appCapabilities: {}, protocolVersion: '2026-01-26'
    });
    applyHostContext(init?.hostContext);
    hostConnected = true;
    notify('ui/notifications/initialized');
  }
  const query = { ids: state.sessionSource === 'recent' ? [] : state.ids,
    fallback: state.sessionSource !== 'host', period: state.view === 'overview' ? '30D' : state.period,
    date: state.view === 'usage' ? state.date : null, context: state.view === 'context',
    orchestrationTurns: state.view === 'session', force };
  if (demo) return window.monitorDemo(query);
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
  const checkpoint = appearance.checkpoint();
  try {
    let data = await readData(force);
    if (refreshPending) {
      forcePending ||= force;
      return;
    }
    if (state.sessionSource === 'host' && data.panels[0]?.main.conversationId !== hostConversationId) {
      data = { ...data, panels: [] };
    }
    result = data;
    const panelIds = data.panels.map((panel) => panel.main.conversationId);
    state.ids = state.sessionSource === 'host' && !panelIds.includes(hostConversationId)
      ? [hostConversationId] : panelIds;
    appearance.receive(data.appearance, checkpoint);
    render(data);
    if (demo) connection('演示数据', 'demo');
    else if (data.quota.online) connection('已连接', 'online');
    else connection(data.sources.present ? '本地记录' : '无本地记录', 'offline');
    renderDataSource(data);
    if (force) refreshFeedback.finish(true);
  } catch (error) {
    if (force) refreshFeedback.finish(false);
    connection(result ? '保留旧数据' : '读取失败', result ? 'stale' : 'error');
    if (!result) showContent(`<section class="surface empty">${escape(t(error.message))}</section>`);
    else if (content.querySelector('[data-loading-context]')) {
      showContent(`<section class="surface empty">${t('暂时无法读取上下文，点击右上角刷新重试。')}</section>`);
    }
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
  if (view === 'context' && result?.panels.some((panel) => !panel.context)) {
    showContent(`<section class="surface empty" data-loading-context data-i18n="正在读取上下文…">${t('正在读取上下文…')}</section>`);
  } else if (result) render(result);
  void refresh();
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  const { view, go: destination, date, period, remove } = button.dataset;
  if (view || destination) go(view || destination);
  if (date) {
    if (state.view !== 'usage') {
      state.period = '30D';
      state.heatPage = 0;
      state.date = date;
      go('usage');
    } else {
      state.date = state.date === date ? null : date;
      void refresh();
    }
  }
  if (period || button.hasAttribute('data-clear')) {
    if (period && period !== state.period) {
      state.period = period;
      state.heatPage = 0;
    }
    state.date = null;
    void refresh();
  }
  if (button.dataset.heatPage && result) {
    state.heatPage = Math.max(0, state.heatPage + Number(button.dataset.heatPage));
    render(result);
  }
  if (remove) {
    if (state.sessionSource === 'recent') state.sessionSource = 'manual';
    state.ids = state.ids.filter((id) => id !== remove);
    void refresh();
  }
  if (button === refreshButton && refreshFeedback.begin()) void refresh(true);
  if (button === appearanceButton) {
    appearancePanel.hidden = !appearancePanel.hidden;
    appearanceButton.setAttribute('aria-expanded', String(!appearancePanel.hidden));
    if (hostConnected) notify('ui/notifications/size-changed', { height: document.documentElement.scrollHeight });
  }
});

appearancePanel.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  if (appearance.closeThemeMenu(appearancePanel)) return;
  appearanceButton.click();
  appearanceButton.focus();
});

content.addEventListener('keydown', heatmapKeydown);
content.addEventListener('change', (event) => {
  const { dataset, id, value } = event.target;
  if (dataset.orchestrationTurn && result) {
    state.orchestrationTurns.set(dataset.orchestrationTurn, value);
    render(result);
    return;
  }
  if (!value) return;
  if (id === 'session-select') {
    state.sessionSource = value === hostConversationId ? 'host' : 'manual';
    state.ids = [value, ...state.ids.slice(1).filter((item) => item !== value)];
  } else if (id === 'compare' && state.ids.length < 4) {
    if (state.sessionSource === 'recent') state.sessionSource = 'manual';
    state.ids = [...state.ids, value];
  } else return;
  void refresh();
});

function refreshVisiblePane() {
  if (!demo && paneVisible && !document.hidden && !busy && !document.activeElement?.matches('select')) {
    void refresh();
  }
}

if (framed && !demo) {
  new IntersectionObserver(([entry]) => {
    const wasVisible = paneVisible;
    paneVisible = entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0;
    if (paneVisible && !wasVisible) refreshVisiblePane();
  }).observe(document.documentElement);
  document.addEventListener('visibilitychange', refreshVisiblePane);
  setInterval(refreshVisiblePane, 20000);
}
void refresh();
