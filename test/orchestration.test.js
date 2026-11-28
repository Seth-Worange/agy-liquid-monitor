'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeOrchestration } = require('../src/core/orchestration');
const { parseGenMetadata } = require('../src/core/pb');
const { mergeConversationCalls } = require('../src/core/session');

const live = (executionId, model, modelDisplayName, inputTokens, plannerConfig) => ({
  executionId, plannerConfig, chatModel: { model, modelDisplayName, usage: { inputTokens } }
});

test('orchestration groups recorded turns and preserves observed handoff order', () => {
  const rows = [
    live('standalone', 'MODEL_PLACEHOLDER_M533', 'Gemini 4 Neon (Medium)', 1000),
    live('paired', 'MODEL_PLACEHOLDER_M533', 'Gemini 4 Neon (Medium)', 200),
    live('paired', 'MODEL_PLACEHOLDER_M525', 'Gemini 4 Hydrogen (High)', 300),
    live('paired', 'MODEL_PLACEHOLDER_M533', 'Gemini 4 Neon (Medium)', 100, {
      planModel: 'MODEL_PLACEHOLDER_M533', planExecuteConfig: { executionModel: 'MODEL_PLACEHOLDER_M525' }
    })
  ];
  const data = computeOrchestration(rows, 'Orchestrator');
  assert.equal(data.active, true);
  assert.equal(data.runs, 1);
  assert.deepEqual(data.usage.planner, { calls: 2, tokens: 300 });
  assert.deepEqual(data.usage.executor, { calls: 1, tokens: 300 });
  assert.deepEqual(data.latest.timeline.map((item) => item.role), ['planner', 'executor', 'planner']);
  assert.equal(computeOrchestration(rows.slice(0, 1), null), null);
  assert.equal(computeOrchestration([], 'Orchestrator').runs, 0);
});

test('user turns take precedence over call config, including switching back to direct mode', () => {
  const calls = [
    { stepIndex: 1, modelNum: 1532, inputTokens: 100, ttftMs: 250 },
    { stepIndex: 2, modelNum: 1525, inputTokens: 200, streamingMs: 1900, orchestrator: { planner: 1525, executor: 1525 } },
    { stepIndex: 4, modelNum: 1525, inputTokens: 300 },
    { stepIndex: 6, modelNum: 1525, inputTokens: 400 },
    { stepIndex: 8, modelNum: 1525, inputTokens: 500 }
  ];
  const routes = [
    { stepIndex: 0, planner: 1532, executor: 1525 },
    { stepIndex: 3, planner: 1525, executor: 1525 },
    { stepIndex: 5, planner: 1525, executor: null }
  ];
  const data = computeOrchestration(calls, null, routes, 6, true);
  assert.equal(data.runs, 2);
  assert.deepEqual(data.usage, {
    planner: { calls: 1, tokens: 100 }, executor: { calls: 1, tokens: 200 }, unknown: { calls: 1, tokens: 300 }
  });
  assert.deepEqual(data.latest.usage.unknown, { calls: 1, tokens: 300 });
  assert.deepEqual(data.turns.map((turn) => [turn.id, turn.durationMs]), [['step-0', 2150], ['step-3', null]]);
  assert.deepEqual(data.turns[0].timeline.map((item) => item.tokens), [100, 200]);
});

test('later fallback configs do not reassign earlier calls in the same execution', () => {
  const calls = [
    { executionId: 'run', modelNum: 1532, inputTokens: 100, orchestrator: { planner: 1532, executor: 1525 } },
    { executionId: 'run', modelNum: 1525, inputTokens: 200, orchestrator: { planner: 1525, executor: 1525 } }
  ];
  const data = computeOrchestration(calls);
  assert.deepEqual(data.usage.planner, { calls: 1, tokens: 100 });
  assert.deepEqual(data.latest.usage.unknown, { calls: 1, tokens: 200 });
});

test('live and stored calls fill gaps and preserve distinct responses on the same step', () => {
  const day = '2026-11-24';
  const stored = [
    { executionId: 'old', responseId: 'old-1', stepIndex: 1, modelNum: 533, inputTokens: 10 },
    { executionId: 'run', responseId: 'shared', stepIndex: 2, dateKey: day, inputTokens: 20 },
    { executionId: 'run', stepIndex: 3, dateKey: day, inputTokens: 30 }
  ];
  const liveCalls = [
    { ...live('run', 'MODEL_PLACEHOLDER_M525', 'Gemini 4 Hydrogen', 31), responseId: 'new-3', stepIndices: [3] },
    { ...live('run', 'MODEL_PLACEHOLDER_M525', 'Gemini 4 Hydrogen', 21), responseId: 'shared', stepIndices: [2] },
    { ...live('run', 'MODEL_PLACEHOLDER_M525', 'Gemini 4 Hydrogen', 22), responseId: 'other', stepIndices: [2] }
  ];
  const merged = mergeConversationCalls(stored, liveCalls);
  assert.deepEqual(merged.map((row) => row.responseId), ['old-1', 'shared', 'other', 'new-3']);
  assert.deepEqual(merged.map((row) => row.chatModel?.usage.inputTokens || row.inputTokens), [10, 21, 22, 31]);
  assert.equal(merged[1].dateKey, day);
});

test('SQLite pair config is decoded and same-model calls remain unassigned', () => {
  const databaseConfig = Buffer.from('1a0908f50be2030308f50b', 'hex');
  const { orchestrator } = parseGenMetadata(databaseConfig);
  assert.deepEqual(orchestrator, { planner: 1525, executor: 1525 });
  const data = computeOrchestration([{ orchestrator, modelNum: 1525, inputTokens: 200 }]);
  assert.deepEqual(data.usage.unknown, { calls: 1, tokens: 200 });
  assert.equal(data.usage.planner.calls, 0);
  assert.equal(data.usage.executor.calls, 0);
});
