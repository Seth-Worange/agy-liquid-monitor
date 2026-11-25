function mountLiquidMonitor(api, stylesheet, geminiFont) {
  if (!api?.snapshot || document.querySelector('[data-agy-liquid-panel]')) return;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(stylesheet);
  if (document.fonts && typeof FontFace === 'function') {
    const bytes = Uint8Array.from(atob(geminiFont), (byte) => byte.charCodeAt(0));
    void new FontFace('AGY Gemini', bytes, { weight: '500 650' }).load()
      .then((font) => document.fonts.add(font)).catch(() => {});
  }
  const state = { period: '30D', date: null };
  const views = createMonitorViews(state);
  const labels = { session: '会话', context: '上下文', agents: '子代理', quota: '模型额度', usage: '历史用量' };
  const validId = /^[a-z0-9][a-z0-9-]{0,127}$/i;
  const systemTheme = matchMedia('(prefers-color-scheme: light)');
  const composerBars = new Map();
  const icons = {
    session: '<path d="M2.5 7.5h10v5h-7l-3 2zM5 10h5"/>',
    context: '<circle cx="8" cy="8" r="5.5"/><path d="M8 2.5v5.7h5.5"/>',
    agents: '<circle cx="6" cy="5" r="2"/><path d="M2 13v-1.5A2.5 2.5 0 0 1 4.5 9h3a2.5 2.5 0 0 1 2.5 2.5V13m1-9a2 2 0 0 1 0 4m1.5 1.5a2.5 2.5 0 0 1 1.5 2.2V13"/>',
    usage: '<path d="M3 13V8m5 5V3m5 10V6"/>',
    chevron: '<path d="m4 6 4 4 4-4"/>',
    refresh: '<path d="M13.5 4v4H9.5m4-.5A5.5 5.5 0 1 0 13 11"/>',
    close: '<path d="m4 4 8 8m0-8-8 8"/>'
  };
  const icon = (name) => `<svg class="${name}" viewBox="0 0 16 16" aria-hidden="true">${icons[name]}</svg>`;
  let result = null;
  let open = null;
  let ids = [];
  let model = null;
  let pending = false;
  let queued = false;
  let forceQueued = false;
  let revision = 0;

  function host(attributes) {
    const el = document.createElement('span');
    for (const [key, value] of Object.entries(attributes)) el.setAttribute(key, value);
    const root = el.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [sheet];
    return { el, root };
  }

  function makeBar(kind, sections) {
    const bar = host({ 'data-hud-bar': kind, 'data-agy-liquid': '' });
    bar.sections = sections;
    bar.id = null;
    bar.root.innerHTML = `<div class="status-bar" role="group" aria-label="${kind === 'top' ? 'Antigravity 用量' : '当前会话监控'}">${sections.map((key, index) =>
      `${kind === 'top' && index ? '<span class="status-divider" aria-hidden="true"></span>' : ''}
      <button class="status-button" type="button" data-section="${key}" aria-label="${labels[key]}" aria-haspopup="dialog"
        aria-expanded="false" title="${labels[key]}"></button>`).join('')}</div>`;
    bar.root.addEventListener('click', (event) => {
      const button = event.target.closest('[data-section]');
      if (!button || button.getAttribute('aria-disabled') === 'true') return;
      const { section } = button.dataset;
      if (open?.button === button) closePanel();
      else openPanel(bar, button, section);
    });
    return bar;
  }

  const top = makeBar('top', ['quota', 'usage']);
  const portal = host({ 'data-agy-liquid-panel': '' });
  portal.root.innerHTML = `<section class="hud-popover" role="dialog" aria-modal="false" aria-labelledby="hud-title" popover="manual">
    <header class="hud-heading"><div><h2 id="hud-title"></h2><small class="hud-subtitle"></small></div>
    <div class="hud-actions"><button type="button" class="icon-button" data-refresh title="刷新" aria-label="刷新">${icon('refresh')}</button>
    <button type="button" class="icon-button" data-close title="关闭" aria-label="关闭">${icon('close')}</button></div></header>
    <div class="hud-detail"></div></section>`;
  document.body.append(portal.el);
  const popover = portal.root.querySelector('.hud-popover');
  const detail = portal.root.querySelector('.hud-detail');

  function miniRing(value, color = 'cyan') {
    const fraction = Number.isFinite(value) ? Math.min(100, Math.max(0, value * 100)) : 0;
    return `<span class="mini-ring" aria-hidden="true" style="--fraction:${fraction}%;--fill:var(--${color})"></span>`;
  }

  function updateBar(bar) {
    const panel = result?.panels.find((item) => item.main.conversationId === bar.id);
    const water = panel?.main.waterline;
    const agents = panel?.subagentSummary;
    const rings = result?.quota.summaryRings;
    const color = { green: 'green', orange: 'amber', red: 'red' }[water?.level] || 'blue';
    const values = {
      session: [icon('session'), '会话', views.tokens(panel?.totalTokens)],
      context: [water ? miniRing(water.ratio, color) : icon('context'), '上下文',
        views.percent(water?.ratio) + (panel?.main.compaction.count ? ` · ${panel.main.compaction.count}×` : '')],
      agents: [icon('agents'), '子代理', agents?.totalCount ? `${agents.runningCount}/${agents.totalCount}` : panel ? '0' : '—'],
      usage: [icon('usage'), '今日', views.tokens(result?.usage.today.totalTokens)]
    };
    for (const key of bar.sections) {
      const button = bar.root.querySelector(`[data-section="${key}"]`);
      if (bar !== top) button.setAttribute('aria-disabled', String(!bar.id));
      const readout = key === 'quota'
        ? [rings?.window5h, rings?.window7d].map((bucket, index) => `<span class="quota-pair">${miniRing(bucket?.remainingFraction, index ? 'blue' : 'cyan')}
          <span>${index ? '7d' : '5h'}</span><strong>${views.percent(bucket?.remainingFraction)}</strong></span>`).join('') + icon('chevron')
        : `${values[key][0]}<span class="${bar === top ? '' : 'optional'}">${values[key][1]}</span><strong>${values[key][2]}</strong>`;
      if (button.innerHTML !== readout) button.innerHTML = readout;
      button.setAttribute('aria-label', key === 'quota'
        ? `模型额度，5 小时 ${views.percent(rings?.window5h?.remainingFraction)}，7 天 ${views.percent(rings?.window7d?.remainingFraction)}`
        : `${labels[key]} ${values[key][2]}`);
    }
  }

  function detectTheme() {
    const roots = [document.documentElement, document.body];
    for (const el of roots) {
      const attr = el.getAttribute('data-theme');
      if (attr === 'light' || attr === 'dark') return attr;
      if (el.classList.contains('dark') || el.classList.contains('light')) return el.classList.contains('dark') ? 'dark' : 'light';
    }
    for (const el of roots) {
      const colorScheme = getComputedStyle(el).colorScheme;
      if (colorScheme === 'light' || colorScheme === 'dark') return colorScheme;
    }
    for (const el of roots) {
      const rgb = getComputedStyle(el).backgroundColor.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
      if (rgb) return Number(rgb[1]) * .2126 + Number(rgb[2]) * .7152 + Number(rgb[3]) * .0722 < 128 ? 'dark' : 'light';
    }
    return systemTheme.matches ? 'light' : 'dark';
  }

  function routeIds() {
    const match = /^\/c\/([^/]+)/.exec(location.pathname);
    if (!match) return [];
    try {
      return decodeURIComponent(match[1]).split('+').filter((id) => validId.test(id));
    } catch {
      return [];
    }
  }

  function placeBars() {
    const titlebar = document.querySelector('[class*="@container/titlebar"]');
    const nativeActions = document.querySelector('[data-testid="pane-titlebar-toolbar"], [data-testid="toggle-aux-sidebar"]');
    const titleGroup = titlebar?.firstElementChild || nativeActions?.parentElement;
    if (titleGroup && top.el.parentElement !== titleGroup) titleGroup.append(top.el);
    const triggers = [...document.querySelectorAll('[data-testid="model-selector-trigger"]')]
      .filter((trigger) => trigger.getClientRects().length && trigger.closest('.agy-composer-footer, [data-testid="agent-input-box"]'));
    const visible = new Set(triggers);
    for (const [trigger, bar] of composerBars) {
      if (visible.has(trigger)) continue;
      bar.el.remove();
      composerBars.delete(trigger);
    }
    const fromRoute = routeIds();
    const focusedRoute = new URLSearchParams(location.search).get('focused');
    const active = [];
    let preferredModel = null;
    triggers.forEach((trigger, index) => {
      const footer = trigger.closest('.agy-composer-footer');
      const box = trigger.closest('[data-testid="agent-input-box"]');
      const cascade = trigger.closest('[data-cascade-id]');
      const id = cascade ? cascade.getAttribute('data-cascade-id')
        : triggers.length === 1 ? (focusedRoute || fromRoute[0]) : fromRoute[index];
      const focused = !trigger.closest('[data-pane-unfocused]') && (!focusedRoute || focusedRoute === id);
      let bar = composerBars.get(trigger);
      if (!bar) {
        bar = makeBar('composer', ['session', 'context', 'agents']);
        composerBars.set(trigger, bar);
      }
      bar.id = validId.test(id || '') ? id : null;
      const width = (footer || box || trigger.parentElement).getBoundingClientRect().width;
      const stacked = width < 600 && box?.parentElement;
      bar.el.toggleAttribute('data-stacked', Boolean(stacked));
      bar.el.toggleAttribute('data-compact', width < 355);
      if (stacked) {
        if (box.nextElementSibling !== bar.el) box.after(bar.el);
      } else {
        const parent = footer || trigger.parentElement;
        const rightControls = parent.lastElementChild;
        if (bar.el.parentElement !== parent) {
          if (footer && rightControls !== bar.el) parent.insertBefore(bar.el, rightControls);
          else parent.append(bar.el);
        }
      }
      if (bar.id) focused ? active.unshift(bar.id) : active.push(bar.id);
      if (focused || !preferredModel) {
        preferredModel = trigger.getAttribute('aria-label')?.match(/current:\s*(.+)$/i)?.[1] || trigger.textContent?.trim();
      }
    });
    const theme = detectTheme();
    for (const bar of [top, ...composerBars.values(), portal]) if (bar.el.dataset.theme !== theme) bar.el.dataset.theme = theme;
    if (open && (!open.button.isConnected || open.bar.id !== open.id)) closePanel(false);
    reposition();
    const nextIds = [...new Set(active)].slice(0, 4);
    if (nextIds.join(',') !== ids.join(',') || preferredModel !== model) {
      ids = nextIds;
      model = preferredModel;
      revision++;
      void refresh();
    }
    paintBars();
  }

  function paintBars() {
    for (const bar of [top, ...composerBars.values()]) updateBar(bar);
  }

  function reposition() {
    if (!open) return;
    const anchor = open.button.getBoundingClientRect();
    const width = popover.offsetWidth;
    const left = Math.max(8, Math.min(innerWidth - width - 8, open.bar === top ? anchor.left : anchor.right - width));
    const above = open.bar !== top && anchor.top > 240;
    const available = above ? anchor.top - 16 : innerHeight - anchor.bottom - 16;
    popover.style.maxHeight = `${Math.max(96, available)}px`;
    const y = above ? anchor.top - popover.offsetHeight - 8 : anchor.bottom + 8;
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(Math.max(8, y))}px`;
  }

  function closePanel(restoreFocus = true) {
    if (!open) return;
    const { button } = open;
    open = null;
    revision++;
    popover.hidePopover();
    button.setAttribute('aria-expanded', 'false');
    if (restoreFocus) button.focus({ preventScroll: true });
  }

  function openPanel(bar, button, section) {
    closePanel(false);
    open = { bar, button, section, id: bar.id };
    revision++;
    button.setAttribute('aria-expanded', 'true');
    portal.el.style.fontFamily = getComputedStyle(bar.el).fontFamily;
    popover.dataset.popover = section;
    portal.root.querySelector('#hud-title').textContent = labels[section];
    renderPanel();
    popover.showPopover();
    reposition();
    portal.root.querySelector('[data-close]').focus({ preventScroll: true });
    void refresh();
  }

  function renderPanel() {
    if (!open) return;
    const panel = result?.panels.find((item) => item.main.conversationId === open.id);
    portal.root.querySelector('.hud-subtitle').innerHTML = panel
      ? views.modelName(panel.main.latestModel?.displayName || '') +
        (panel.main.latestModel?.effort ? ` · ${views.escape(panel.main.latestModel.effort)}` : '')
      : '';
    let html = '<p class="note">正在读取 Antigravity 数据…</p>';
    if (result) {
      const templates = {
        session: () => panel && views.sessionDetail(panel),
        context: () => panel && (panel.context ? views.contextDetail(panel) : null),
        agents: () => panel && views.agentDetail(panel),
        quota: () => views.quotaView(result.quota),
        usage: () => views.usageView(result.usage, result.quota.profile)
      };
      html = templates[open.section]() || (open.id && !panel
        ? '<p class="note">当前会话还没有可读取的模型调用。</p>' : html);
    }
    if (detail.innerHTML !== html) detail.innerHTML = html;
    reposition();
  }

  async function refresh(force = false) {
    if (pending) {
      queued = true;
      forceQueued ||= force;
      return;
    }
    pending = true;
    const requestRevision = revision;
    try {
      const data = await api.snapshot({
        ids, period: state.period, date: state.date, context: open?.section === 'context',
        currentModel: model, fallback: false, force
      });
      if (requestRevision === revision) {
        result = data;
        paintBars();
        renderPanel();
      }
    } catch {
      if (open && !result) detail.innerHTML = '<p class="note">暂时无法读取数据。可点击刷新重试。</p>';
    } finally {
      pending = false;
      if (queued) {
        const nextForce = forceQueued;
        queued = forceQueued = false;
        void refresh(nextForce);
      }
    }
  }

  portal.root.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-close')) closePanel();
    else if (button.hasAttribute('data-refresh')) void refresh(true);
    else if (button.dataset.period || button.dataset.date || button.hasAttribute('data-clear')) {
      if (button.dataset.period) state.period = button.dataset.period;
      state.date = state.date === button.dataset.date ? null : button.dataset.date || null;
      revision++;
      void refresh();
    }
  });
  document.addEventListener('pointerdown', (event) => {
    if (open && !event.composedPath().includes(portal.el) &&
      !event.composedPath().some((el) => el.hasAttribute?.('data-agy-liquid'))) closePanel(false);
  }, true);
  document.addEventListener('keydown', (event) => {
    if (open && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closePanel();
    }
  }, true);
  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      placeBars();
    });
  }
  new MutationObserver(schedule).observe(document.documentElement, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ['class', 'style', 'data-theme', 'data-cascade-id', 'data-pane-unfocused', 'aria-label']
  });
  window.addEventListener('resize', schedule);
  window.addEventListener('popstate', schedule);
  window.navigation?.addEventListener('navigatesuccess', schedule);
  systemTheme.addEventListener('change', schedule);
  setInterval(() => {
    if (!document.hidden) void refresh();
  }, 12000);
  placeBars();
  if (!pending) void refresh();
}
