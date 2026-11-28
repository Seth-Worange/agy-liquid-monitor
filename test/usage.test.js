'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const usage = require('../src/core/usage');
const { combineSessionWithSubagents, computeSessionStats } = require('../src/core/session');

test('history and session detail agree on mixed-model usage and estimated cost', () => {
  const nowMs = new Date(2026, 10, 24, 12).getTime();
  const calls = ['Gemini 4 Neon', 'Gemini 4 Carbon', 'Custom Unknown Model'].map((modelDisplayName) =>
    ({ modelDisplayName, timestampMs: nowMs, inputTokens: 100000, outputTokens: 10000 }));
  Object.assign(calls[1], { modelDisplayName: 'Orchestrator (Neon)', responseModel: 'gemini-4-carbon' });
  const input = { conversationId: 'mixed', calls };
  const report = usage.computeUsageReport([input], { nowMs });
  const { totalCost } = combineSessionWithSubagents(computeSessionStats(input));
  assert.deepEqual(report.byModel.map((model) => [model.modelKey, model.totalTokens]), [
    ['gemini-4-neon', 110000], ['gemini-4-carbon', 110000], ['custom-unknown-model', 110000]
  ]);
  assert.ok(Math.abs(report.summary.estUsd - 0.75) < 1e-9);
  assert.equal(totalCost.costUsd, report.summary.estUsd);
  assert.equal(totalCost.unpricedTokens, report.summary.unpricedTokens);
});

test('usage: 7D/30D/ALL summary, heatmap levels, By Model, Top 3 rollup, and day selection', () => {
  const nowMs = Date.parse('2026-11-24T15:00:00+08:00');
  const sessions = [
    {
      conversationId: 'root-a',
      rootConversationId: 'root-a',
      isChild: false,
      title: 'Main Task A',
      lastModifiedMs: Date.parse('2026-11-24T10:00:00+08:00'),
      calls: [
        {
          timestampMs: Date.parse('2026-11-24T10:00:00+08:00'),
          modelDisplayName: 'Gemini 4 Carbon (Medium)',
          inputTokens: 100000,
          outputTokens: 10000,
          cacheReadTokens: 0,
          ttftMs: 1000,
          streamingMs: 4000
        }
      ]
    },
    {
      conversationId: 'child-a-wf',
      rootConversationId: 'root-a',
      isChild: true,
      title: 'Workflow Batch 1',
      lastModifiedMs: Date.parse('2026-11-24T10:05:00+08:00'),
      calls: [
        {
          timestampMs: Date.parse('2026-11-24T10:05:00+08:00'),
          modelDisplayName: 'Gemini 4 Hydrogen (High)',
          inputTokens: 200000,
          outputTokens: 20000,
          cacheReadTokens: 0,
          ttftMs: 2000,
          streamingMs: 5000
        }
      ]
    },
    {
      conversationId: 'root-b',
      rootConversationId: 'root-b',
      isChild: false,
      title: 'Big Old Task B',
      lastModifiedMs: Date.parse('2026-11-10T10:00:00+08:00'),
      calls: [
        {
          timestampMs: Date.parse('2026-11-10T10:00:00+08:00'),
          modelDisplayName: 'Gemini 4 Neon (XHigh)',
          inputTokens: 500000,
          outputTokens: 50000,
          cacheReadTokens: 0,
          ttftMs: 3000,
          streamingMs: 7000
        }
      ]
    },
    {
      conversationId: 'root-c',
      rootConversationId: 'root-c',
      isChild: false,
      title: 'Mid Task C',
      lastModifiedMs: Date.parse('2026-11-22T12:00:00+08:00'),
      calls: [
        {
          timestampMs: Date.parse('2026-11-22T12:00:00+08:00'),
          modelDisplayName: 'Claude Opus 5.5 (High)',
          inputTokens: 50000,
          outputTokens: 5000,
          cacheReadTokens: 0,
          ttftMs: 1000,
          streamingMs: 2000
        }
      ]
    },
    {
      conversationId: 'root-u',
      rootConversationId: 'root-u',
      isChild: false,
      title: 'Unpriced Old Task',
      lastModifiedMs: Date.parse('2026-11-12T10:00:00+08:00'),
      calls: [
        {
          timestampMs: Date.parse('2026-11-12T10:00:00+08:00'),
          modelDisplayName: 'Custom Experimental Model (High)',
          inputTokens: 100000,
          outputTokens: 10000,
          cacheReadTokens: 0,
          ttftMs: 1000,
          streamingMs: 1000
        }
      ]
    }
  ];

  const r7 = usage.computeUsageReport(sessions, { period: '7D', nowMs });
  assert.equal(r7.range.days, 7);
  assert.equal(r7.today.totalTokens, 330000);
  assert.equal(r7.summary.tokens, 330000 + 55000);
  assert.equal(r7.summary.activeChats, 2); // root-a (with child) + root-c
  assert.equal(r7.summary.activeDays, 2);
  assert.equal(r7.summary.dailyAvgTokens, (330000 + 55000) / 2);
  // The calendar and rankings cover the same seven days.
  assert.equal(r7.heatmap.length, 7);
  assert.equal(r7.heatmap[0].dateKey, r7.range.startKey);
  assert.equal(r7.heatmap.at(-1).dateKey, r7.range.endKey);
  assert.equal(r7.heatmap.find((d) => d.dateKey === '2026-11-24').level, 4);
  assert.equal(r7.topSessions[0].conversationId, 'root-a');
  assert.equal(r7.topSessions[0].mainTokens, 110000);
  assert.equal(r7.topSessions[0].subagentTokens, 220000);
  assert.equal(r7.topSessions[0].subagentCount, 1);

  const sumByModel7 = r7.byModel.reduce((s, m) => s + m.totalTokens, 0);
  assert.equal(sumByModel7, r7.summary.tokens);

  // Clicking 2026-11-22 scopes BOTH Top 3 AND By Model to that day only
  const rDay = usage.computeUsageReport(sessions, {
    period: '7D',
    nowMs,
    selectedDateKey: '2026-11-22'
  });
  assert.equal(rDay.topSessions.length, 1);
  assert.equal(rDay.topSessions[0].conversationId, 'root-c');
  assert.equal(rDay.byModel.length, 1);
  assert.equal(rDay.byModel[0].modelKey, 'claude-opus-5-5');
  assert.equal(rDay.byModel[0].totalTokens, 55000);
  assert.equal(rDay.byModel[0].shareRatio, 1);
  assert.equal(rDay.selectedDay.totalTokens, 55000);
  assert.equal(rDay.heatmap.length, 7);
  const outside = usage.computeUsageReport(sessions, { period: '7D', nowMs, selectedDateKey: '2026-11-10' });
  assert.equal(outside.selectedDateKey, null);
  assert.deepEqual(outside.byModel, r7.byModel);

  // Clicking a day >7 days ago (2026-11-10) works directly and prices Gemini 4 Neon
  const rOldDay = usage.computeUsageReport(sessions, {
    period: '30D',
    nowMs,
    selectedDateKey: '2026-11-10'
  });
  assert.equal(rOldDay.topSessions.length, 1);
  assert.equal(rOldDay.topSessions[0].conversationId, 'root-b');
  assert.equal(rOldDay.byModel[0].modelKey, 'gemini-4-neon');
  assert.equal(rOldDay.byModel[0].isPriced, true);
  // 0.5*3 + 0.05*15 = 1.5 + 0.75 = 2.25
  assert.ok(Math.abs(rOldDay.byModel[0].costUsd - 2.25) < 1e-9);

  // 30D includes root-b (Neon, priced) and root-u (unpriced)
  const r30 = usage.computeUsageReport(sessions, { period: '30D', nowMs });
  assert.equal(r30.range.days, 30);
  assert.equal(r30.summary.tokens, 385000 + 550000 + 110000);
  assert.equal(r30.summary.hasUnpriced, true);
  assert.equal(r30.summary.unpricedTokens, 110000);
  assert.equal(r30.summary.dailyAvgTokens, (385000 + 550000 + 110000) / 4);
  assert.equal(r30.topSessions[0].conversationId, 'root-b');
  assert.equal(r30.heatmap.length, 30);
  assert.ok(r30.byModel.length > r7.byModel.length);

  // ALL includes each day from the first recorded use.
  const rAll = usage.computeUsageReport(sessions, { period: 'ALL', nowMs });
  assert.equal(rAll.range.startKey, '2026-11-10');
  assert.equal(rAll.range.days, 15);
  assert.equal(rAll.heatmap.length, 15);
  assert.equal(rAll.heatmap[0].dateKey, '2026-11-10');
  assert.equal(rAll.heatmap[0].level, 4);
  assert.equal(rAll.heatmap.reduce((sum, day) => sum + day.totalTokens, 0), rAll.summary.tokens);
});
