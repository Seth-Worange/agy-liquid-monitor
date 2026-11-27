'use strict';

const { buildQuotaSnapshot } = require('../src/core/quota');
const { computeSessionStats, combineSessionWithSubagents } = require('../src/core/session');
const { CONTEXT_CATEGORIES } = require('../src/core/context');
const { computeUsageReport } = require('../src/core/usage');

function demoData(nowMs = Date.now()) {
  const conversations = [
    ['design', '桌面看板视觉迭代', 'Gemini 4 Carbon (High)'],
    ['sync', '同步模块诊断', 'Claude Sonnet 5.5'],
    ['kernel', '本地缓存项目整理', 'Gemini 3.8 Flash'],
    ['review', '组件交互审查', 'Gemini 4 Carbon']
  ];
  const weights = [0, 41, 32, 65, 17, 0, 92, 46, 105, 62, 0, 21, 33, 80, 55, 0, 87, 54, 38, 104, 39, 69, 38, 89, 61, 112, 52, 79, 50, 128];
  const sessions = conversations.map(([conversationId, title, modelDisplayName], index) => ({
    conversationId, title, calls: weights.flatMap((weight, day) => {
      if (!weight || (day + index) % 4 === 2) return [];
      const date = new Date(nowMs);
      date.setDate(date.getDate() - (29 - day));
      const scale = [2200, 1500, 470, 340][index];
      return [{
        timestampMs: date.getTime(), modelDisplayName,
        inputTokens: Math.round(weight * scale * 0.18),
        cacheReadTokens: Math.round(weight * scale * 0.77),
        outputTokens: Math.round(weight * scale * 0.05),
        ttftMs: 560 + day * 7 + index * 50, streamingMs: 12000 + weight * 5700,
        maxContextTokens: 500000
      }];
    })
  }));
  const older = new Date(nowMs);
  older.setDate(older.getDate() - 63);
  sessions[1].calls.unshift({ ...sessions[1].calls[0], timestampMs: older.getTime(), cacheReadTokens: 120000 });
  sessions[0].calls.at(-1).startStepIndex = 42;
  sessions[0].calls.at(-2).cacheReadTokens += 245000;
  const panels = sessions.map((sess, index) => {
    const main = computeSessionStats({ ...sess, turns: 13 - index * 3, checkpointCount: index === 0 ? 2 : 0 });
    const children = index === 0 ? [
      ['组件核查', 'Running'], ['界面回归', 'Done'], ['可访问性检查', 'Done']
    ].map(([title, normalizedStatus], child) => ({
      ...computeSessionStats({ title, calls: [{
        modelDisplayName: 'Gemini 3.8 Flash', inputTokens: 17100 - child * 3700,
        outputTokens: 700, maxContextTokens: 128000
      }] }),
      normalizedStatus
    })) : [];
    const breakdown = [0.09, 0.08, 0.06, 0.14, 0.63];
    return {
      ...combineSessionWithSubagents(main, children), live: index === 0,
      context: {
        breakdownAvailable: true,
        categories: CONTEXT_CATEGORIES.map((category, i) => ({
          ...category, ratio: breakdown[i], tokens: Math.round(breakdown[i] * main.waterline.usedTokens)
        }))
      }
    };
  });
  const pools = [
    ['gemini_main', 'Gemini', .72, .58],
    ['claude', 'Claude', .94, .43],
    ['gemini_argon', 'Gemini Argon', .83, .5]
  ];
  const isoAfter = (hours) => new Date(nowMs + hours * 3600000).toISOString();
  const quota = buildQuotaSnapshot({
    quotaSummaryRes: { groups: pools.map(([groupId, displayName, hour, week], i) => ({
      groupId, displayName, buckets: [
        { bucketId: groupId + '-5h', window: '5h', remainingFraction: hour, resetTime: isoAfter(2 + i) },
        { bucketId: groupId + '-7d', window: '7d', remainingFraction: week, resetTime: isoAfter(101 - 18 * i) }
      ]
    })) },
    userStatusRes: { name: '演示账号', userTier: { id: 'pro', name: 'Google AI Pro' } },
    nowMs, currentModel: panels[0].main.latestModel
  });
  const reports = Object.fromEntries(['7D', '30D', 'ALL'].map((period) =>
    [period, computeUsageReport(sessions, { period, nowMs })]));
  const days = Object.fromEntries(reports.ALL.heatmap.map(({ dateKey }) => {
    const { byModel, topSessions, selectedDay, selectedDateKey } =
      computeUsageReport(sessions, { period: 'ALL', nowMs, selectedDateKey: dateKey });
    return [dateKey, { byModel, topSessions, selectedDay, selectedDateKey }];
  }));
  return {
    reports, days, panels,
    quota: { profile: quota.profile, pools: quota.pools, summaryRings: quota.summaryRings, online: true },
    menu: sessions.map(({ conversationId, title }) => ({ id: conversationId, title }))
  };
}

module.exports = { demoData };
