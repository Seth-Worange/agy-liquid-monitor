function createMonitorViews(state) {
  const exact = new Intl.NumberFormat('en-US');
  const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });
  const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 3 });
  const format = (value, formatter) => Number.isFinite(value) ? formatter.format(value) : '—';
  const tokens = (value) => format(value, compact);
  const percent = (value) => Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—';
  const duration = (ms) => {
    if (!Number.isFinite(ms)) return '—';
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)} 秒`;
    if (ms < 3600000) return `${(ms / 60000).toFixed(1)} 分`;
    return `${(ms / 3600000).toFixed(1)} 小时`;
  };
  const countdown = (ms) => {
    if (!Number.isFinite(ms)) return '重置时间未知';
    const minutes = Math.max(0, Math.ceil((ms - Date.now()) / 60000));
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor(minutes / 60) % 24;
    return minutes ? `${days ? days + ' 天 ' : ''}${hours ? hours + ' 小时 ' : ''}${minutes % 60} 分后重置` : '等待重置';
  };
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const fraction = (value) => Number.isFinite(value) ? Math.min(100, Math.max(0, value * 100)) : 0;
  const estimate = (value, partial) => `${format(value, usd)}${partial && Number.isFinite(value) ? ' + 未定价' : ''}`;
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
    if (water?.awaitingMeasurement) return ring(null, { label: '上下文待测量', big });
    const count = panel?.main.compaction?.count;
    const color = { green: 'green', orange: 'amber', red: 'red' }[water?.level] || 'blue';
    return ring(water?.ratio, {
      label: count ? `上下文 · 已压缩 ${count} 次` : '上下文',
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
      <figcaption><span>近 14 天 Token 趋势</span><span>${escape(tokens(peak))} 峰值</span></figcaption>
      <svg viewBox="0 0 408 148" preserveAspectRatio="none" role="img" aria-label="近 14 天 Token 趋势">
        <defs><linearGradient id="plot-fill" x2="0" y2="1"><stop stop-color="var(--blue)" stop-opacity=".38"/><stop offset="1" stop-color="var(--blue)" stop-opacity="0"/></linearGradient></defs>
        <path d="M8 34H400 M8 69H400 M8 104H400 M8 139H400" stroke="var(--edge)" stroke-dasharray="3 5" fill="none"/>
        <polygon points="8,139 ${pointsString} ${lastX},139" fill="url(#plot-fill)"/>
        <polyline points="${pointsString}" fill="none" stroke="var(--cyan)" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
        <circle cx="${lastX}" cy="${lastY}" r="4" fill="var(--cyan)"/>
      </svg></figure>`;
  }

  function heatmap(days) {
    const tabDate = days.some((day) => day.dateKey === state.date) ? state.date : days.at(-1)?.dateKey;
    const peak = Math.max(0, ...days.map((day) => day.totalTokens));
    const cells = days.map(({ dateKey, totalTokens }) => {
      const label = `${dateKey} · ${exact.format(totalTokens)} Token`;
      // Give smaller days more room in the color scale, even when one day is unusually busy.
      const fill = totalTokens > 0 && peak > 0 ? (24 + 76 * Math.sqrt(totalTokens / peak)).toFixed(2) + '%' : null;
      return `<button class="heat-cell" data-date="${escape(dateKey)}"${fill ? ` style="--heat-fill:${fill}"` : ''}
        aria-label="${escape(label)}" title="${escape(label)}" aria-pressed="${dateKey === state.date}" tabindex="${dateKey === tabDate ? 0 : -1}"></button>`;
    }).join('');
    return `<div class="heatmap"><div class="heat-grid" role="group" aria-label="活动热力图，可用方向键选择日期">${cells}</div><div class="heat-label meta">
      <span>${escape(days[0]?.dateKey || '')}</span><span>${escape(days.at(-1)?.dateKey || '')}</span></div></div>`;
  }

  function modelList(models, count = models.length) {
    return models.length ? `<div class="lines">${models.slice(0, count).map((model, index) =>
      line(model.displayName, `${tokens(model.totalTokens)} · ${percent(model.shareRatio)}`, model.shareRatio, index === 0 ? 'cyan' : 'blue', true)).join('')}</div>`
      : '<p class="note small-metrics">此时间范围暂无模型调用。</p>';
  }

  function overview(data) {
    const { usage, panels, quota } = data;
    const panel = panels[0];
    const today = usage.today;
    const sessionLabel = { host: '当前对话', manual: '已选会话' }[state.sessionSource] || '最近会话';
    const { window5h, window7d } = quota.summaryRings;
    return `<section class="surface overview-hero"><div>
      <p class="eyebrow">今日用量</p><div class="hero-number">${tokens(today.totalTokens)}<small>Token</small></div>
      <p class="meta">${escape(today.dateKey)} · ${escape(quota.profile.planFullName || '本地使用记录')}</p>
      <div class="hero-stats">
        ${metric('预估 API 费用', estimate(today.costUsd, today.hasUnpriced))}
        ${metric('输入', tokens(today.inputTokens))}
        ${metric('输出', tokens(today.outputTokens))}
      </div></div>${chart(usage.heatmap)}</section>
      <div class="summary-grid">
        <button class="surface summary-card row" data-go="quota"><div><h3>模型剩余额度</h3><strong>${modelName(window5h?.poolTitle || window7d?.poolTitle || '暂无额度')}</strong>
          <span class="meta">5 小时 / 7 天</span></div><div class="rings">${ring(window5h?.remainingFraction, { label: '5 小时' })}${ring(window7d?.remainingFraction, { label: '7 天', color: 'violet' })}</div></button>
        <button class="surface summary-card" data-go="session"><h3>${sessionLabel}</h3><strong>${tokens(panel?.totalTokens)}</strong>
          <span class="meta">${modelName(panel?.main.latestModel?.displayName || '暂无会话')}${panel ? ' · ' + panel.main.turns + ' 轮' : ''}</span></button>
        <button class="surface summary-card row" data-go="context"><div><h3>上下文窗口</h3><strong>${panel?.main.waterline.awaitingMeasurement ? '待测量' : percent(panel?.main.waterline.ratio)}</strong>
          <span class="meta">${panel?.main.waterline.awaitingMeasurement ? '已压缩，等待下一次模型调用' :
            `${tokens(panel?.main.waterline.usedTokens)} / ${tokens(panel?.main.waterline.contextLimit)} Token`}</span></div>${contextRing(panel)}</button>
      </div>
      <div class="overview-lower">
        <section class="surface pane"><div class="section-head"><h2>活动热力图</h2><span class="meta">近 30 天</span></div>${heatmap(usage.heatmap)}</section>
        <section class="surface pane"><div class="section-head"><h2>模型用量</h2><span class="meta">近 30 天</span></div>${modelList(usage.byModel, 3)}</section>
      </div>`;
  }

  function sessionPicker(data) {
    const unselected = data.menu.filter((item) => !state.ids.includes(item.id));
    const options = (id) => (data.menu.some((item) => item.id === id) ? '' :
      '<option value="" selected disabled>请选择会话</option>') + data.menu.map((item) =>
      `<option value="${escape(item.id)}" ${item.id === id ? 'selected' : ''}>${escape(item.title)}</option>`).join('');
    return `<div class="surface pane filter-row"><label for="session-select">选择会话</label>
      <select class="select" id="session-select">${options(state.ids[0])}</select>
      ${data.panels.length && state.ids.length < 4 && unselected.length ? `<select class="select" id="compare" aria-label="添加对比会话"><option value="">添加对比会话</option>
      ${unselected.map((item) => `<option value="${escape(item.id)}">${escape(item.title)}</option>`).join('')}</select>` : ''}</div>`;
  }

  function sessionDetail({ main, totalCost, totalTokens, subagentSummary }) {
    const split = [
      ['缓存读取', main.cacheReadTokens, 'violet'], ['缓存写入', main.cacheWriteTokens, 'violet'],
      ['输入', main.inputTokens, 'cyan'], ['输出', main.outputTokens, 'blue']
    ];
    return `<div class="detail-columns"><div class="metrics">
      ${metric('累计 Token', tokens(totalTokens))}
      ${metric('预估费用', estimate(totalCost.costUsd, totalCost.hasUnpriced))}
      ${metric('对话轮数 / 模型调用', `${main.turns} / ${main.steps}`)}
      ${metric('平均首字延迟', duration(main.avgTtftMs))}
      ${metric('输出速度', main.outputSpeedTps == null ? fallback : `${Math.round(main.outputSpeedTps)} T/s`)}
      ${metric('模型耗时', duration(main.modelTimeMs))}
      </div><div><div class="section-head"><h3>主会话 Token 构成</h3><span class="meta">缓存命中 ${percent(main.cacheHitRate)}</span></div>
      <div class="lines">${split.map(([label, value, color]) => line(label, tokens(value), value / main.totalTokens, color)).join('')}</div></div>
      </div><p class="note small-metrics">${subagentSummary.totalCount ? `总量包含 ${subagentSummary.totalCount} 个子代理。 ` : ''}费用按内置公开 API 单价估算。</p>`;
  }

  function contextDetail(panel) {
    const { main, context } = panel;
    const { waterline, compaction } = main;
    if (waterline.awaitingMeasurement) {
      return '<p class="eyebrow">上下文窗口 · 待测量</p><p class="note small-metrics">已完成压缩。Antigravity 会在下一次模型调用后提供新的上下文用量。</p>';
    }
    return `<div class="row"><div><p class="eyebrow">上下文窗口占用</p><div class="metric small-metrics">
      <strong>${tokens(waterline.usedTokens)} / ${tokens(waterline.contextLimit)}</strong><p class="meta">Token · ${percent(waterline.ratio)}</p>
      </div></div>${contextRing(panel, true)}</div>
      <p class="note small-metrics">${compaction.count
        ? `已压缩 ${compaction.count} 次${compaction.lastBeforeTokens != null && compaction.lastAfterTokens != null
          ? ` · 最近一次 ${tokens(compaction.lastBeforeTokens)} → ${tokens(compaction.lastAfterTokens)} Token` : ''}`
        : '未记录到上下文压缩。'}</p>
      <div class="section-head small-metrics"><h3>占用构成</h3><span class="meta">按内容估算</span></div>
      ${context?.breakdownAvailable ? `<div class="lines">${context.categories.map((item, index) =>
        line(categories[item.key] || item.label, `${tokens(item.tokens)} · ${percent(item.ratio)}`, item.ratio, contextColors[index])).join('')}</div>`
        : '<p class="note small-metrics">当前会话暂无可读取的分类明细。</p>'}`;
  }

  function agentDetail({ subagentSummary: group }) {
    return `<div class="metrics">${metric('运行中', group.runningCount)}${metric('子代理总数', group.totalCount)}</div>
      ${group.items.length ? `<div class="sessions">${group.items.map((item) => `
      <div class="row session-row"><div><h3>${escape(item.title)}</h3><p class="meta">${modelName(item.modelDisplayName)}
        · 上下文 ${tokens(item.currentContextTokens)} Token ${item.waterline.ratio == null ? '' : ' · ' + percent(item.waterline.ratio)}</p></div>
        <span class="status" data-status="${escape(item.status)}">${escape(statusNames[item.status] || item.status)}</span></div>`).join('')}</div>` : '<p class="note small-metrics">当前会话暂无子代理。</p>'}`;
  }

  function sessionView(data, renderPanel) {
    if (!data.panels.length) {
      const message = state.sessionSource === 'host' ? '当前对话暂无可读取的会话用量。' : '暂无本地会话。开启一次 Antigravity 对话后刷新。';
      return (data.menu.length ? sessionPicker(data) : '') + `<section class="surface empty">${message}</section>`;
    }
    return `<div class="stack">${sessionPicker(data)}<div class="pane-grid ${data.panels.length === 1 ? 'solo' : ''}">
      ${data.panels.map((panel, index) => {
        const model = panel.main.latestModel;
        return `<section class="surface pane"><div class="panel-heading"><div><h2>${escape(panel.main.title)}</h2>
          <p class="meta">${modelName(model?.displayName || '模型未知')}${model?.effort ? ` · ${escape(model.effort)}` : ''}
          · ${panel.live ? '实时' : '本地记录'}</p></div>
          ${index > 0 ? `<button class="subtle-button" data-remove="${escape(panel.main.conversationId)}" aria-label="移除此对比会话">移除</button>` : ''}</div>
          ${renderPanel(panel)}</section>`;
      }).join('')}</div></div>`;
  }

  function quotaView(quota) {
    const { window5h, window7d } = quota.summaryRings;
    return `<div class="stack"><section class="surface pane"><div class="section-head"><div><h2>${escape(quota.profile.planFullName || '账号额度')}</h2>
      <p class="meta">${escape(quota.profile.name || (quota.online ? 'Antigravity 账号' : '本地服务未连接'))}</p></div>
      <div class="rings">${ring(window5h?.remainingFraction, { label: '5 小时剩余', big: true })}
      ${ring(window7d?.remainingFraction, { label: '7 天剩余', color: 'violet', big: true })}</div></div>
      <p class="note small-metrics">${modelName(window5h?.poolTitle || window7d?.poolTitle || '当前额度池')} · 5 小时 / 7 天剩余</p></section>
      ${quota.pools.length ? `<div class="pane-grid">${quota.pools.map((pool) => {
        const pace = pool.weeklyCycle?.pace;
        return `<section class="surface pane"><h3>${modelName(pool.title)}</h3><p class="meta">${pool.models.map(modelName).join(' · ')}</p>
          ${pool.buckets.length ? `<div class="lines">${pool.buckets.map((bucket) => line(
            `${bucket.shortLabel} · ${countdown(bucket.resetAtMs)}`, percent(bucket.remainingFraction), bucket.remainingFraction,
            bucket.windowKey === '7d' ? 'violet' : 'cyan')).join('')}</div>` : '<p class="note small-metrics">暂无额度数据。</p>'}
          ${pace ? `<p class="note small-metrics">周消耗速率 · ${escape(paceNames[pace.state] || pace.label)}
            ${pace.multiplier == null ? '' : ' · ' + Math.min(99, pace.multiplier).toFixed(1) + '×'}</p>` : ''}</section>`;
      }).join('')}</div>` : '<section class="surface empty">打开已登录的 Antigravity 桌面端后，刷新以读取额度。</section>'}</div>`;
  }

  function usageView(usage, profile) {
    const { summary, topSessions } = usage;
    const periods = [['7D', '7 天'], ['30D', '30 天'], ['ALL', '全部']];
    return `<div class="stack"><section class="surface pane"><div class="section-head"><div><h2>历史用量</h2>
      <p class="meta">${escape([profile.name, profile.planFullName, `${usage.range.startKey} – ${usage.range.endKey}`].filter(Boolean).join(' · '))}</p></div>
      <div class="segmented" role="group" aria-label="统计周期">${periods.map(([value, label]) =>
        `<button data-period="${value}" class="${state.period === value ? 'selected' : ''}" aria-pressed="${state.period === value}">${label}</button>`).join('')}</div></div>
      <div class="metrics small-metrics">
        ${metric('总 Token', tokens(summary.tokens))}
        ${metric('预估 API 费用', estimate(summary.estUsd, summary.hasUnpriced))}
        ${metric('活跃日均 Token', tokens(summary.dailyAvgTokens))}
        ${metric('单会话平均 Token', tokens(summary.avgPerChatTokens))}
        ${metric('日均模型耗时', duration(summary.dailyTimeMs))}
      </div></section>
      <section class="surface pane"><div class="section-head"><h2>活动热力图</h2>
        ${state.date ? `<button class="subtle-button" data-clear>清除 ${escape(state.date)} 筛选</button>` : '<span class="meta">近 30 天 · 日期仅筛选明细</span>'}</div>
        ${heatmap(usage.heatmap)}</section>
      <div class="pane-grid"><section class="surface pane"><h2>模型用量</h2>${modelList(usage.byModel)}</section>
      <section class="surface pane"><h2>会话用量 Top 3</h2>
        ${topSessions.length ? `<div class="sessions">${topSessions.map((session) =>
          `<div class="row session-row"><div><h3>${escape(session.title)}</h3><p class="meta">${modelName(session.primaryModel?.displayName || '')}</p></div>
           <span class="line-value">${tokens(session.totalTokens)} Token</span></div>`).join('')}</div>`
          : '<p class="note small-metrics">此时间范围暂无会话用量。</p>'}</section></div></div>`;
  }

  return { overview, sessionView, sessionDetail, contextDetail, agentDetail, quotaView, usageView, escape, tokens, percent, ring, contextRing, modelName };
}
