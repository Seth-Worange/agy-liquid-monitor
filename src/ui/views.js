function createMonitorViews(state, t, language) {
  const exact = new Intl.NumberFormat('en-US');
  const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });
  const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 3 });
  const format = (value, formatter) => Number.isFinite(value) ? formatter.format(value) : '—';
  const tokens = (value) => format(value, compact);
  const percent = (value) => Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—';
  const duration = (ms) => {
    if (!Number.isFinite(ms)) return '—';
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60000) return t('{0} 秒', (ms / 1000).toFixed(1));
    if (ms < 3600000) return t('{0} 分', (ms / 60000).toFixed(1));
    return t('{0} 小时', (ms / 3600000).toFixed(1));
  };
  const countdown = (ms) => {
    if (!Number.isFinite(ms)) return t('重置时间未知');
    const minutes = Math.max(0, Math.ceil((ms - Date.now()) / 60000));
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor(minutes / 60) % 24;
    const remaining = [days && t('{0} 天', days), hours && t('{0} 小时', hours), t('{0} 分', minutes % 60)].filter(Boolean).join(' ');
    return minutes ? t('{0} 后重置', remaining) : t('等待重置');
  };
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const fraction = (value) => Number.isFinite(value) ? Math.min(100, Math.max(0, value * 100)) : 0;
  const estimate = (value, partial) => `${format(value, usd)}${partial && Number.isFinite(value) ? ' ' + t('+ 未定价') : ''}`;
  const fallback = '—';
  const contextColors = ['violet', 'blue', 'cyan', 'green', 'amber'];
  const categories = { system_prompt: '系统提示词', skills_rules: '技能与规则', mcp_tools: 'MCP 工具', builtin_tools: '内置工具', messages_outputs: '消息与输出' };
  const statusNames = { Running: '运行中', Done: '已完成', Error: '出错' };
  const paceNames = { on_track: '消耗低于计划', on_pace: '消耗符合计划', high_burn: '消耗较快', early: '周期刚开始', depleted: '已用完' };

  function modelName(label = '') {
    return escape(label).replace(/\b(Gemini|Claude|(?:Chat)?GPT|OpenAI)\b/gi, (name) => {
      const family = /^gemini$/i.test(name) ? 'gemini' : /^claude$/i.test(name) ? 'claude' : 'gpt';
      return `<span class="model-brand ${family}">${name}</span>`;
    });
  }

  function metric(label, value) {
    return `<div class="metric"><small>${escape(label)}</small><strong>${escape(value)}</strong></div>`;
  }

  function ring(value, { label = '', text = percent(value), color = 'cyan', big = false } = {}) {
    return `<span class="ring ${big ? 'big' : ''}" role="img" aria-label="${escape(`${label} ${percent(value)}`)}" style="--fraction:${fraction(value)}%;--fill:var(--${color})">${escape(text)}</span>`;
  }

  function line(label, value, ratio, color = 'blue', brand = false) {
    return `<div class="line"><div class="row"><span class="line-label">${brand ? modelName(label) : escape(label)}</span><span class="line-value">${escape(value)}</span></div>
      <div class="meter" aria-hidden="true"><i style="--fraction:${fraction(ratio)}%;--fill:var(--${color})"></i></div></div>`;
  }

  function contextRing(panel, big = false) {
    const water = panel?.main.waterline;
    if (water?.awaitingMeasurement) return ring(null, { label: t('上下文待测量'), big });
    const count = panel?.main.compaction?.count;
    const color = { green: 'green', orange: 'amber', red: 'red' }[water?.level] || 'blue';
    return ring(water?.ratio, {
      label: count ? t('上下文 · 已压缩 {0} 次', count) : t('上下文'),
      text: count ? `${count}×` : percent(water?.ratio), color, big
    });
  }

  function chart(points) {
    const samples = points.slice(-14);
    if (!samples.length) return '';
    const peak = Math.max(...samples.map((day) => day.totalTokens));
    const max = Math.max(1, peak);
    const coordinates = samples.map((day, index) =>
      [Math.round(8 + 392 * index / Math.max(1, samples.length - 1)), Math.round(138 - 116 * day.totalTokens / max)]);
    const pointsString = coordinates.map((point) => point.join(',')).join(' ');
    const [lastX, lastY] = coordinates.at(-1);
    return `<figure class="hero-chart">
      <figcaption><span>${t('近 14 天 Token 趋势')}</span><span>${t('峰值 {0}', escape(tokens(peak)))}</span></figcaption>
      <svg viewBox="0 0 408 148" preserveAspectRatio="none" role="img" aria-label="${t('近 14 天 Token 趋势')}">
        <defs><linearGradient id="plot-fill" x2="0" y2="1"><stop stop-color="var(--blue)" stop-opacity=".38"/><stop offset="1" stop-color="var(--blue)" stop-opacity="0"/></linearGradient></defs>
        <path d="M8 34H400 M8 69H400 M8 104H400 M8 139H400" stroke="var(--edge)" stroke-dasharray="3 5" fill="none"/>
        <polygon points="8,139 ${pointsString} ${lastX},139" fill="url(#plot-fill)"/>
        <polyline points="${pointsString}" fill="none" stroke="var(--cyan)" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
        <circle cx="${lastX}" cy="${lastY}" r="4" fill="var(--cyan)"/>
      </svg></figure>`;
  }

  function heatmap(days, { selected = null, allDays = days } = {}) {
    const tabDate = days.some((day) => day.dateKey === selected) ? selected : days.at(-1)?.dateKey;
    const totals = [...new Set(allDays.map((day) => day.totalTokens).filter((value) => value > 0))].sort((a, b) => a - b);
    const colors = new Map(totals.map((value, index) => [value,
      totals.length === 1 ? 5 : 1 + Math.round(4 * index / (totals.length - 1))]));
    const cells = days.map(({ dateKey, totalTokens }) => {
      const label = `${dateKey} · ${exact.format(totalTokens)} Token`;
      return `<button class="heat-cell" data-date="${escape(dateKey)}" data-heat-color="${colors.get(totalTokens) || 0}"
        aria-label="${escape(label)}" title="${escape(label)}" aria-pressed="${dateKey === selected}" tabindex="${dateKey === tabDate ? 0 : -1}"></button>`;
    }).join('');
    return `<div class="heatmap"><div class="heat-grid" role="group" aria-label="${t('活动热力图，可用方向键选择日期')}">${cells}</div><div class="heat-label meta">
      <span>${escape(days[0]?.dateKey || '')}</span><span>${escape(days.at(-1)?.dateKey || '')}</span></div></div>`;
  }

  function modelList(models, count = models.length) {
    return models.length ? `<div class="lines">${models.slice(0, count).map((model, index) =>
      line(model.displayName, `${tokens(model.totalTokens)} · ${percent(model.shareRatio)}`, model.shareRatio, index === 0 ? 'cyan' : 'blue', true)).join('')}</div>`
      : `<p class="note small-metrics">${t('此时间范围暂无模型调用。')}</p>`;
  }

  function overview(data) {
    const { usage, panels, quota } = data;
    const panel = panels[0];
    const today = usage.today;
    const sessionLabel = { host: t('当前对话'), manual: t('已选会话') }[state.sessionSource] || t('最近会话');
    const { window5h, window7d } = quota.summaryRings;
    return `<section class="surface overview-hero"><div>
      <p class="eyebrow">${t('今日用量')}</p><div class="hero-number">${tokens(today.totalTokens)}<small>Token</small></div>
      <p class="meta">${escape(today.dateKey)} · ${escape(quota.profile.planFullName || t('本地使用记录'))}</p>
      <div class="hero-stats">
        ${metric(t('预估 API 费用'), estimate(today.costUsd, today.hasUnpriced))}
        ${metric(t('输入'), tokens(today.inputTokens))}
        ${metric(t('输出'), tokens(today.outputTokens))}
      </div></div>${chart(usage.heatmap)}</section>
      <div class="summary-grid">
        <button class="surface summary-card row" data-go="quota"><div><h3>${t('模型剩余额度')}</h3><strong>${modelName(window5h?.poolTitle || window7d?.poolTitle || t('暂无额度'))}</strong>
          <span class="meta">${t('5 小时 / 7 天')}</span></div><div class="rings">${ring(window5h?.remainingFraction, { label: t('5 小时') })}${ring(window7d?.remainingFraction, { label: t('7 天'), color: 'violet' })}</div></button>
        <button class="surface summary-card" data-go="session"><h3>${sessionLabel}</h3><strong>${tokens(panel?.totalTokens)}</strong>
          <span class="meta">${modelName(panel?.main.latestModel?.displayName || t('暂无会话'))}${panel ? ' · ' + t('{0} 轮', panel.main.turns) : ''}</span></button>
        <button class="surface summary-card row" data-go="context"><div><h3>${t('上下文窗口')}</h3><strong>${panel?.main.waterline.awaitingMeasurement ? t('待测量') : percent(panel?.main.waterline.ratio)}</strong>
          <span class="meta">${panel?.main.waterline.awaitingMeasurement ? t('已压缩，等待下一次模型调用') :
            `${tokens(panel?.main.waterline.usedTokens)} / ${tokens(panel?.main.waterline.contextLimit)} Token`}</span></div>${contextRing(panel)}</button>
      </div>
      <div class="overview-lower">
        <section class="surface pane"><div class="section-head"><h2>${t('活动热力图')}</h2><span class="meta">${t('近 30 天')}</span></div>${heatmap(usage.heatmap)}</section>
        <section class="surface pane"><div class="section-head"><h2>${t('模型用量')}</h2><span class="meta">${t('近 30 天')}</span></div>${modelList(usage.byModel, 3)}</section>
      </div>`;
  }

  function sessionPicker(data) {
    const unselected = data.menu.filter((item) => !state.ids.includes(item.id));
    const options = (id) => (data.menu.some((item) => item.id === id) ? '' :
      `<option value="" selected disabled>${t('请选择会话')}</option>`) + data.menu.map((item) =>
      `<option value="${escape(item.id)}" ${item.id === id ? 'selected' : ''}>${escape(item.title)}</option>`).join('');
    return `<div class="surface pane filter-row"><label for="session-select">${t('选择会话')}</label>
      <select class="select" id="session-select">${options(state.ids[0])}</select>
      ${data.panels.length && state.ids.length < 4 && unselected.length ? `<select class="select" id="compare" aria-label="${t('添加对比会话')}"><option value="">${t('添加对比会话')}</option>
      ${unselected.map((item) => `<option value="${escape(item.id)}">${escape(item.title)}</option>`).join('')}</select>` : ''}</div>`;
  }

  function orchestrationDetail(data, conversationId) {
    if (!data) return '';
    const labels = { planner: t('规划'), executor: t('执行'), unknown: t('角色未区分') };
    const scope = data.active ? t('已选模式') : t('会话记录');
    const showModel = (value) => value ? modelName(value) : t('模型未记录');
    const rows = (usage, roles) => ['planner', 'executor', 'unknown']
      .filter((role) => role !== 'unknown' || usage.unknown.calls > 0).map((role) => {
        const item = usage[role];
        return `<div class="row"><div><strong>${labels[role]}</strong>${roles && role !== 'unknown'
          ? `<div class="meta">${showModel(roles[role])}</div>` : ''}</div><span class="line-value">${tokens(item.tokens)} Token · ${t('{0} 次', item.calls)}</span></div>`;
      }).join('');
    const latest = data.latest;
    const turns = data.turns || [];
    const selected = turns.find((turn) => turn.id !== latest?.id && turn.id === state.orchestrationTurns?.get(conversationId));
    const turn = selected || latest;
    const picker = state.orchestrationTurns && turns.length > 1
      ? `<select class="select orchestration-picker" data-orchestration-turn="${escape(conversationId)}" aria-label="${t('选择编排轮次')}">
          <option value="latest">${t('最近一轮 · 第 {0} 轮', latest.number)}</option>
          ${turns.filter((entry) => entry.id !== latest.id).reverse().map((entry) => `<option value="${escape(entry.id)}"${entry === selected ? ' selected' : ''}>${t('第 {0} 轮', entry.number)}</option>`).join('')}
        </select>` : '';
    return `<section class="orchestration"><div class="section-head"><h3>Orchestrator</h3><span class="meta">${scope}</span></div>
      ${turn ? `<div class="section-head small-metrics"><h3>${selected ? t('第 {0} 轮编排', turn.number) : t('最近一轮编排')}</h3>${picker}</div>
      <div class="lines">${rows(turn.usage, turn.roles)}</div>
      <div class="section-head small-metrics"><h3>${t('模型调用顺序')}</h3>${turn.durationMs !== null
        ? `<span class="meta">${t('模型耗时')} ${duration(turn.durationMs)}</span>` : ''}</div>
      <ol class="orchestration-timeline">${turn.timeline.map((item) =>
        `<li><span>${labels[item.role]} · ${showModel(item.model)}</span><span class="meta">${t('{0} 次', item.calls)} · ${tokens(item.tokens)} Token${item.durationMs === null ? '' : ` · ${duration(item.durationMs)}`}</span></li>`).join('')}</ol>
      ${data.runs > 1 ? `<h3 class="small-metrics">${t('本会话累计 · {0} 轮编排', data.runs)}</h3><div class="lines">${rows(data.usage)}</div>` : ''}`
      : `<p class="note small-metrics">${t('已选择编排模式，等待 Antigravity 记录规划与执行调用。')}</p>`}</section>`;
  }

  function sessionDetail({ main, totalCost, totalTokens, subagentSummary, orchestration }) {
    const split = [
      [t('缓存读取'), main.cacheReadTokens, 'violet'], [t('缓存写入'), main.cacheWriteTokens, 'violet'],
      [t('输入'), main.inputTokens, 'cyan'], [t('输出'), main.outputTokens, 'blue']
    ];
    return `<div class="detail-columns"><div class="metrics">
      ${metric(t('累计 Token'), tokens(totalTokens))}
      ${metric(t('预估费用'), estimate(totalCost.costUsd, totalCost.hasUnpriced))}
      ${metric(t('对话轮数 / 模型调用'), `${main.turns} / ${main.steps}`)}
      ${metric(t('平均首字延迟'), duration(main.avgTtftMs))}
      ${metric(t('输出速度'), main.outputSpeedTps == null ? fallback : `${Math.round(main.outputSpeedTps)} T/s`)}
      ${metric(t('模型耗时'), duration(main.modelTimeMs))}
      </div><div><div class="section-head"><h3>${t('主会话 Token 构成')}</h3><span class="meta">${t('缓存命中')} ${percent(main.cacheHitRate)}</span></div>
      <div class="lines">${split.map(([label, value, color]) => line(label, tokens(value), value / main.totalTokens, color)).join('')}</div></div>
      </div><p class="note small-metrics">${subagentSummary.totalCount ? t('总量包含 {0} 个子代理。', subagentSummary.totalCount) + ' ' : ''}${t('费用按内置公开 API 单价估算。')}</p>
      ${orchestrationDetail(orchestration, main.conversationId)}`;
  }

  function contextTrendView(points) {
    if (!points?.length) return '';
    const samples = points.filter((point) => point.kind === 'sample');
    const peak = Math.max(1, ...samples.map((point) => point.tokens));
    const firstAt = samples[0]?.timestampMs;
    const lastAt = samples.at(-1)?.timestampMs;
    const showTimes = Number.isFinite(firstAt) && Number.isFinite(lastAt) && firstAt < lastAt;
    const sampleTime = new Intl.DateTimeFormat(language(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const x = (index) => 12 + index * 416 / Math.max(points.length - 1, 1);
    const y = (value) => 90 - value * 77 / peak;
    const checkpointLabel = (point) => point.inferred ? t('上下文起点变化') : t('上下文压缩');
    const trace = points.map((point, index) => point.kind === 'sample'
      ? `${points[index - 1]?.kind === 'sample' ? 'L' : 'M'}${x(index)} ${y(point.tokens)}` : '').join(' ');
    const checkpoints = points.map((point, index) => point.kind === 'checkpoint'
      ? `<line class="trend-checkpoint" x1="${x(index)}" x2="${x(index)}" y1="9" y2="90"><title>${checkpointLabel(point)}</title></line>` : '').join('');
    const markers = points.map((point, index) => point.kind === 'sample'
      ? `<circle class="${point.modelChanged ? 'trend-switch' : point.afterCheckpoint ? 'trend-after' : 'trend-point'}" cx="${x(index)}" cy="${y(point.tokens)}" r="${point.modelChanged || point.afterCheckpoint ? 4 : 2.5}"><title>${exact.format(point.tokens)} Token${point.model ? ' · ' + escape(point.model) : ''}</title></circle>` : '').join('');
    const events = points.flatMap((point, index) => {
      if (point.kind === 'checkpoint') {
        const after = points[index + 1]?.kind === 'sample' ? points[index + 1].tokens : null;
        return [`<li><span>${checkpointLabel(point)}</span><span>${point.beforeTokens == null ? '—' : tokens(point.beforeTokens)} → ${after == null ? (index === points.length - 1 ? t('待测量') : t('暂无读数')) : tokens(after) + ' Token'}</span></li>`];
      }
      return point.modelChanged ? [`<li><span>${t('换用 {0}', escape(point.model))}</span><span>${tokens(point.tokens)} Token</span></li>`] : [];
    });
    return `<section class="small-metrics context-trend"><div class="section-head"><h3>${t('上下文用量趋势')}</h3><span class="meta">${samples.length ? t('峰值 {0}', tokens(peak) + ' Token') : t('按调用顺序')}</span></div>
      ${samples.length ? `<svg viewBox="0 0 440 100" role="img" aria-label="${t('最近模型调用的上下文 Token 趋势')}">
        <line class="trend-baseline" x1="12" x2="428" y1="90" y2="90"/>${checkpoints}<path class="trend-trace" d="${trace}"/>${markers}
      </svg><div class="row meta"><span>${showTimes ? sampleTime.format(firstAt) : t('较早调用')}</span><span>${showTimes ? sampleTime.format(lastAt) : t('最近调用')}</span></div>` : ''}
      ${events.length ? `<ul class="context-trend-events" aria-label="${t('最近的压缩与模型切换')}">${events.slice(-5).join('')}</ul>` : ''}</section>`;
  }

  function contextDetail(panel) {
    const { main, context } = panel;
    const { waterline, compaction } = main;
    const trend = contextTrendView(panel.contextTrend);
    if (waterline.awaitingMeasurement) {
      return `<p class="eyebrow">${t('上下文窗口 · 待测量')}</p><p class="note small-metrics">${t('已完成压缩。Antigravity 会在下一次模型调用后提供新的上下文用量。')}</p>` + trend;
    }
    return `<div class="row"><div><p class="eyebrow">${t('上下文窗口占用')}</p><div class="metric small-metrics">
      <strong>${tokens(waterline.usedTokens)} / ${tokens(waterline.contextLimit)}</strong><p class="meta">Token · ${percent(waterline.ratio)}</p>
      </div></div>${contextRing(panel, true)}</div>
      <p class="note small-metrics">${compaction.count
        ? t('已压缩 {0} 次', compaction.count) + (compaction.lastBeforeTokens != null && compaction.lastAfterTokens != null
          ? ' · ' + t('最近一次 {0} → {1} Token', tokens(compaction.lastBeforeTokens), tokens(compaction.lastAfterTokens)) : '')
        : t('未记录到上下文压缩。')}</p>
      ${trend}
      <div class="section-head small-metrics"><h3>${t('占用构成')}</h3><span class="meta">${t('按内容估算')}</span></div>
      ${context?.breakdownAvailable ? `<div class="lines">${context.categories.map((item, index) =>
        line(t(categories[item.key] || item.label), `${tokens(item.tokens)} · ${percent(item.ratio)}`, item.ratio, contextColors[index])).join('')}</div>`
        : `<p class="note small-metrics">${t('当前会话暂无可读取的分类明细。')}</p>`}`;
  }

  function agentDetail({ subagentSummary: group }) {
    return `<div class="metrics">${metric(t('运行中'), group.runningCount)}${metric(t('子代理总数'), group.totalCount)}</div>
      ${group.items.length ? `<div class="sessions">${group.items.map((item) => `
      <div class="row session-row"><div><h3>${escape(item.title)}</h3><p class="meta">${modelName(item.modelDisplayName)}
        · ${t('上下文')} ${tokens(item.currentContextTokens)} Token ${item.waterline.ratio == null ? '' : ' · ' + percent(item.waterline.ratio)}</p></div>
        <span class="status" data-status="${escape(item.status)}">${escape(t(statusNames[item.status] || item.status))}</span></div>`).join('')}</div>` : `<p class="note small-metrics">${t('当前会话暂无子代理。')}</p>`}`;
  }

  function sessionView(data, renderPanel) {
    if (!data.panels.length) {
      const message = state.sessionSource === 'host' ? t('当前对话暂无可读取的会话用量。') : t('暂无本地会话。开启一次 Antigravity 对话后刷新。');
      return (data.menu.length ? sessionPicker(data) : '') + `<section class="surface empty">${message}</section>`;
    }
    return `<div class="stack">${sessionPicker(data)}<div class="pane-grid ${data.panels.length === 1 ? 'solo' : ''}">
      ${data.panels.map((panel, index) => {
        const model = panel.main.latestModel;
        return `<section class="surface pane"><div class="panel-heading"><div><h2>${escape(panel.main.title)}</h2>
          <p class="meta">${modelName(model?.displayName || t('模型未知'))}${model?.effort ? ` · ${escape(model.effort)}` : ''}
          · ${panel.live ? t('实时') : t('本地记录')}</p></div>
          ${index > 0 ? `<button class="subtle-button" data-remove="${escape(panel.main.conversationId)}" aria-label="${t('移除此对比会话')}">${t('移除')}</button>` : ''}</div>
          ${renderPanel(panel)}</section>`;
      }).join('')}</div></div>`;
  }

  function quotaView(quota) {
    const { window5h, window7d } = quota.summaryRings;
    return `<div class="stack"><section class="surface pane"><div class="section-head"><div><h2>${escape(quota.profile.planFullName || t('账号额度'))}</h2>
      <p class="meta">${escape(quota.profile.name || (quota.online ? t('Antigravity 账号') : t('本地服务未连接')))}</p></div>
      <div class="rings">${ring(window5h?.remainingFraction, { label: t('5 小时剩余'), big: true })}
      ${ring(window7d?.remainingFraction, { label: t('7 天剩余'), color: 'violet', big: true })}</div></div>
      <p class="note small-metrics">${modelName(window5h?.poolTitle || window7d?.poolTitle || t('当前额度池'))} · ${t('5 小时 / 7 天剩余')}</p></section>
      ${quota.pools.length ? `<div class="pane-grid">${quota.pools.map((pool) => {
        const pace = pool.weeklyCycle?.pace;
        return `<section class="surface pane"><h3>${modelName(pool.title)}</h3><p class="meta">${pool.models.map(modelName).join(' · ')}</p>
          ${pool.buckets.length ? `<div class="lines">${pool.buckets.map((bucket) => line(
            `${bucket.shortLabel} · ${countdown(bucket.resetAtMs)}`, percent(bucket.remainingFraction), bucket.remainingFraction,
            bucket.windowKey === '7d' ? 'violet' : 'cyan')).join('')}</div>` : `<p class="note small-metrics">${t('暂无额度数据。')}</p>`}
          ${pace ? `<p class="note small-metrics">${t('周消耗速率')} · ${escape(t(paceNames[pace.state] || pace.label))}
            ${pace.multiplier == null ? '' : ' · ' + Math.min(99, pace.multiplier).toFixed(1) + '×'}</p>` : ''}</section>`;
      }).join('')}</div>` : `<section class="surface empty">${t('打开已登录的 Antigravity 桌面端后，刷新以读取额度。')}</section>`}</div>`;
  }

  function usageView(usage, profile) {
    const { summary, topSessions, selectedDay } = usage;
    const periods = [['7D', t('7 天')], ['30D', t('30 天')], ['ALL', t('全部')]];
    const rangeLabel = `${usage.range.startKey} – ${usage.range.endKey}`;
    const scope = selectedDay?.dateKey || rangeLabel;
    const pageSize = 42;
    const pageCount = Math.max(1, Math.ceil(usage.heatmap.length / pageSize));
    const page = Math.min(state.heatPage || 0, pageCount - 1);
    const end = usage.heatmap.length - page * pageSize;
    const days = usage.heatmap.slice(Math.max(0, end - pageSize), end);
    const paging = pageCount > 1 ? `<div class="heat-paging" role="group" aria-label="${t('热力图日期翻页')}">
      <button type="button" class="subtle-button" data-heat-page="1" aria-label="${t('较早日期')}" ${page === pageCount - 1 ? 'disabled' : ''}>‹</button>
      <button type="button" class="subtle-button" data-heat-page="-1" aria-label="${t('较近日期')}" ${page === 0 ? 'disabled' : ''}>›</button>
    </div>` : '';
    const metrics = selectedDay ? [
      [t('当日 Token'), tokens(selectedDay.totalTokens)],
      [t('预估 API 费用'), estimate(selectedDay.costUsd, selectedDay.hasUnpriced)],
      [t('输入'), tokens(selectedDay.inputTokens)], [t('输出'), tokens(selectedDay.outputTokens)],
      [t('模型耗时'), duration(selectedDay.modelTimeMs)]
    ] : [
      [t('总 Token'), tokens(summary.tokens)], [t('预估 API 费用'), estimate(summary.estUsd, summary.hasUnpriced)],
      [t('活跃日均 Token'), tokens(summary.dailyAvgTokens)], [t('单会话平均 Token'), tokens(summary.avgPerChatTokens)],
      [t('日均模型耗时'), duration(summary.dailyTimeMs)]
    ];
    return `<div class="stack"><section class="surface pane"><div class="section-head"><div><h2>${t('历史用量')}</h2>
      <p class="meta">${escape([profile.name, profile.planFullName, rangeLabel].filter(Boolean).join(' · '))}</p></div>
      <div class="segmented" role="group" aria-label="${t('统计周期')}">${periods.map(([value, label]) =>
        `<button data-period="${value}" class="${usage.period === value ? 'selected' : ''}" aria-pressed="${usage.period === value}">${label}</button>`).join('')}</div></div>
      ${selectedDay ? `<p class="meta small-metrics">${t('已选日期')} · ${escape(scope)}</p>` : ''}
      <div class="metrics small-metrics">${metrics.map(([label, value]) => metric(label, value)).join('')}</div></section>
      <section class="surface pane"><div class="section-head"><h2>${t('活动热力图')}</h2>
        <div class="heat-controls">${selectedDay ? `<button class="subtle-button" data-clear>${t('清除日期')}</button>` : ''}${paging}</div></div>
        ${heatmap(days, { selected: selectedDay?.dateKey, allDays: usage.heatmap })}</section>
      <div class="pane-grid"><section class="surface pane"><h2>${t('模型用量')}</h2><p class="meta">${escape(scope)}</p>${modelList(usage.byModel)}</section>
      <section class="surface pane"><h2>${t('会话用量 Top 3')}</h2><p class="meta">${escape(scope)}</p>
        ${topSessions.length ? `<div class="sessions">${topSessions.map((session) =>
          `<div class="row session-row"><div><h3>${escape(session.title)}</h3><p class="meta">${modelName(session.primaryModel?.displayName || '')}</p></div>
           <span class="line-value">${tokens(session.totalTokens)} Token</span></div>`).join('')}</div>`
          : `<p class="note small-metrics">${t('此时间范围暂无会话用量。')}</p>`}</section></div></div>`;
  }

  return { overview, sessionView, sessionDetail, contextDetail, agentDetail, quotaView, usageView, escape, tokens, percent, ring, contextRing, modelName };
}
