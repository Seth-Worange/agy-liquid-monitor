'use strict';

const { modelEnumNumber, resolveModelIdentity } = require('./pricing');
const { isValidCall, normalizeCall } = require('./session');

function configuredPair(raw) {
  const config = raw.plannerConfig ?? raw.planner_config;
  const routing = config?.planExecuteConfig ?? config?.plan_execute_config;
  const executor = routing?.executionModel ?? routing?.execution_model;
  return executor && executor !== 'MODEL_UNSPECIFIED'
    ? { planner: config.planModel ?? config.plan_model ?? config.modelName, executor }
    : raw.orchestrator || null;
}

function describe(value, observed) {
  const number = modelEnumNumber(value);
  const model = number ? observed.get(number) || resolveModelIdentity({ modelNum: number })
    : resolveModelIdentity(typeof value === 'string' ? value : null);
  return { number, key: model.modelKey, effort: model.effort, label: model.modelKey === 'unknown' ? null : model.displayNameWithEffort };
}

function matches(role, call) {
  if (role.number && call.number) return call.number === role.number;
  return role.key !== 'unknown' && role.key === call.key && (!role.effort || !call.effort || role.effort === call.effort);
}

function emptyUsage() {
  return { planner: { calls: 0, tokens: 0 }, executor: { calls: 0, tokens: 0 }, unknown: { calls: 0, tokens: 0 } };
}

function computeOrchestration(rawCalls, selectedModel, routes = [], lastStoredStep = null, includeTurns = false) {
  const active = /\borchestrator\b/i.test(selectedModel || '');
  const observed = new Map();
  const firstPair = new Map();
  const records = rawCalls.filter(Boolean).map((raw) => {
    const pair = configuredPair(raw);
    const call = normalizeCall(raw);
    const model = resolveModelIdentity(call.modelInput);
    const { modelNum, model: modelId, modelEnum } = call.modelInput;
    const number = modelEnumNumber(modelNum) ?? modelEnumNumber(modelId) ?? modelEnumNumber(modelEnum);
    if (number && model.modelKey !== 'unknown') observed.set(number, model);
    const execution = raw.executionId || raw.execution_id;
    if (execution && pair && !firstPair.has(execution)) firstPair.set(execution, pair);
    return { execution, pair, call, model, number };
  });

  const activePair = new Map();
  const runs = new Map();
  const usage = emptyUsage();
  let latest = null;
  for (const { execution, pair, call, model, number } of records) {
    const prior = activePair.get(execution) || firstPair.get(execution);
    if (execution && pair && (pair.planner !== prior?.planner || pair.executor !== prior?.executor)) {
      activePair.set(execution, pair);
    }
    // A stored user turn governs only the trajectory already visible in SQLite.
    const route = call.stepIndex !== null && lastStoredStep !== null && call.stepIndex <= lastStoredStep
      ? routes.findLast((item) => item.stepIndex <= call.stepIndex) : null;
    const config = route || activePair.get(execution) || firstPair.get(execution) || pair;
    if (!config?.executor || !isValidCall(call)) continue;
    if (!runs.has(config)) {
      const planner = describe(config.planner, observed);
      const executor = describe(config.executor, observed);
      const turnNumber = runs.size + 1;
      const id = route ? `step-${route.stepIndex}` : `record-${call.stepIndex ?? 'unknown'}-${turnNumber}`;
      runs.set(config, {
        id, number: turnNumber, planner, executor, usage: emptyUsage(), timeline: [], durationMs: null
      });
    }
    const run = runs.get(config);
    latest = run;
    const info = { number, key: model.modelKey, effort: model.effort };
    const planning = matches(run.planner, info);
    const executing = matches(run.executor, info);
    const bothKnown = (run.planner.number || run.planner.label) && (run.executor.number || run.executor.label);
    const role = !bothKnown || planning === executing ? 'unknown' : planning ? 'planner' : 'executor';
    for (const totals of [usage, run.usage]) {
      totals[role].tokens += call.totalTokens;
      totals[role].calls++;
    }
    const label = model.modelKey === 'unknown' ? null : model.displayNameWithEffort;
    const elapsed = call.ttftMs === null && call.streamingMs === null
      ? null : (call.ttftMs ?? 0) + (call.streamingMs ?? 0);
    if (elapsed !== null) run.durationMs = (run.durationMs ?? 0) + elapsed;
    const previous = run.timeline.at(-1);
    if (previous?.role === role && previous?.model === label) {
      previous.calls++;
      previous.tokens += call.totalTokens;
      if (elapsed !== null) previous.durationMs = (previous.durationMs ?? 0) + elapsed;
    } else {
      if (!includeTurns && run.timeline.length === 6) run.timeline.shift();
      run.timeline.push({ role, model: label, calls: 1, tokens: call.totalTokens, durationMs: elapsed });
    }
  }
  if (!active && !latest) return null;
  const detail = (run) => ({
    id: run.id, number: run.number, roles: { planner: run.planner.label, executor: run.executor.label },
    usage: run.usage, timeline: run.timeline, durationMs: run.durationMs
  });
  return {
    active,
    runs: runs.size,
    usage,
    latest: latest && detail(latest),
    ...(includeTurns ? { turns: [...runs.values()].map(detail) } : {})
  };
}

module.exports = { computeOrchestration };
