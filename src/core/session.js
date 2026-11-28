'use strict';

const { resolveModelIdentity, resolveCallModel, calculateSessionCost } = require('./pricing');
const { computeContextWaterline } = require('./context');

function toNonNegInt(value) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function parseDurationMsInput(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string') {
    const m = value.trim().match(/^([\d.]+)\s*s$/i);
    if (!m) return null;
    const sec = Number(m[1]);
    return Number.isFinite(sec) && sec >= 0 ? sec * 1000 : null;
  }
  if (typeof value === 'object') {
    const sec = Number(value.seconds || 0);
    const nanos = Number(value.nanos || 0);
    if (!Number.isFinite(sec) || !Number.isFinite(nanos)) return null;
    const ms = sec * 1000 + nanos / 1e6;
    return ms >= 0 ? ms : null;
  }
  return null;
}

function toLocalDateKey(ms) {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function extractMaxContextTokens(cm, raw) {
  const candidates = [
    cm?.maxContextTokens,
    cm?.chatStartMetadata?.contextWindowMetadata?.maxContextTokens,
    cm?.chat_start_metadata?.context_window_metadata?.max_context_tokens,
    raw?.maxContextTokens
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return null;
}

function normalizeTruncationReason(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value === 2 ? 'TRUNCATION_REASON_MAX_TOKEN_LIMIT' : `TRUNCATION_REASON_${Math.floor(value)}`;
  }
  const s = String(value).trim();
  if (!s || s === '0' || s === 'TRUNCATION_REASON_UNSPECIFIED') return null;
  return s;
}

function extractChatStartInfo(cm, raw) {
  const csm =
    cm?.chatStartMetadata ||
    cm?.chat_start_metadata ||
    raw?.chatStartMetadata ||
    raw?.chat_start_metadata ||
    null;
  const cwm = csm?.contextWindowMetadata || csm?.context_window_metadata || null;

  const rawStart = csm?.startStepIndex ?? csm?.start_step_index ?? cm?.startStepIndex ?? raw?.startStepIndex;
  const startNum = Number(rawStart);
  const startStepIndex =
    rawStart !== undefined && rawStart !== null && rawStart !== '' && Number.isFinite(startNum) && startNum >= 0
      ? Math.floor(startNum)
      : null;

  const rawCp = csm?.checkpointIndex ?? csm?.checkpoint_index ?? cm?.checkpointIndex ?? raw?.checkpointIndex;
  const cpNum = Number(rawCp);
  const checkpointIndex =
    rawCp !== undefined && rawCp !== null && rawCp !== '' && Number.isFinite(cpNum)
      ? Math.trunc(cpNum)
      : null;

  const truncationReason = normalizeTruncationReason(
    cwm?.truncationReason ?? cwm?.truncation_reason ?? cm?.truncationReason ?? raw?.truncationReason
  );

  return { startStepIndex, checkpointIndex, truncationReason };
}

function callStepIndex(raw) {
  const indices = raw.stepIndices ?? raw.step_indices;
  return Array.isArray(indices) && indices.length
    ? indices.reduce((last, step) => Number.isInteger(step) ? Math.max(last ?? step, step) : last, null)
    : Number.isInteger(raw.stepIndex) ? raw.stepIndex : null;
}

function normalizeCall(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const cm = raw.chatModel && typeof raw.chatModel === 'object' ? raw.chatModel : raw;
  const usage = cm.usage && typeof cm.usage === 'object' ? cm.usage : cm;

  const inputTokens = toNonNegInt(usage.inputTokens ?? usage.input_tokens);
  const outputTokens = toNonNegInt(usage.outputTokens ?? usage.output_tokens);
  const cacheReadTokens = toNonNegInt(usage.cacheReadTokens ?? usage.cache_read_tokens);
  const cacheWriteTokens = toNonNegInt(usage.cacheWriteTokens ?? usage.cache_write_tokens);
  const thinkingOutputTokens = toNonNegInt(usage.thinkingOutputTokens ?? usage.thinking_output_tokens);
  const responseOutputTokens = toNonNegInt(usage.responseOutputTokens ?? usage.response_output_tokens);

  const ttftMs = parseDurationMsInput(cm.ttftMs ?? cm.timeToFirstToken ?? cm.time_to_first_token);
  const streamingMs = parseDurationMsInput(cm.streamingMs ?? cm.streamingDuration ?? cm.streaming_duration);

  const timestampMs = Number.isFinite(Number(raw.timestampMs)) ? Number(raw.timestampMs) : null;
  const dateKey = raw.dateKey || (timestampMs !== null ? toLocalDateKey(timestampMs) : null);
  const chatStart = extractChatStartInfo(cm, raw);

  return {
    stepIndex: callStepIndex(raw),
    timestampMs,
    dateKey,
    modelInput: {
      modelDisplayName: cm.modelDisplayName ?? cm.model_display_name ?? raw.modelDisplayName ?? '',
      responseModel: cm.responseModel ?? cm.response_model ?? raw.responseModel ?? '',
      modelEnum: cm.modelEnum ?? cm.model_enum ?? raw.modelEnum ?? '',
      modelNum: cm.modelNum ?? raw.modelNum ?? (typeof cm.model === 'number' ? cm.model : null),
      model: typeof cm.model === 'string' ? cm.model : (typeof raw.model === 'string' ? raw.model : '')
    },
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    thinkingOutputTokens,
    responseOutputTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    ttftMs,
    streamingMs,
    maxContextTokens: extractMaxContextTokens(cm, raw),
    startStepIndex: chatStart.startStepIndex,
    checkpointIndex: chatStart.checkpointIndex,
    truncationReason: chatStart.truncationReason
  };
}

function isValidCall(call) {
  return Boolean(call && call.totalTokens > 0);
}

function mergeConversationCalls(stored, live) {
  if (!stored.length) return live;
  if (!live.length) return stored;

  const responseId = (call) => call.chatModel?.usage?.responseId || call.chatModel?.usage?.response_id ||
    call.responseId || call.response_id;
  const stepKey = (call) => {
    const execution = call.executionId || call.execution_id;
    const step = callStepIndex(call);
    return execution && step !== null ? JSON.stringify([execution, step]) : null;
  };
  function uniqueIndex(calls, keyFor) {
    const index = new Map();
    for (const call of calls) {
      const key = keyFor(call);
      if (key) index.set(key, index.has(key) ? null : call);
    }
    return index;
  }
  const storedById = uniqueIndex(stored, responseId);
  const storedByStep = uniqueIndex(stored, stepKey);
  const liveByStep = uniqueIndex(live, stepKey);
  const merged = new Map(stored.map((call) => [call, call]));
  const matched = new Set();
  for (const call of live) {
    const id = responseId(call);
    const key = stepKey(call);
    const sameStep = liveByStep.get(key) === call ? storedByStep.get(key) : null;
    const previous = storedById.get(id) || (sameStep && (!id || !responseId(sameStep)) ? sameStep : null);
    if (!previous || matched.has(previous)) {
      merged.set(call, call);
      continue;
    }
    matched.add(previous);
    const newest = isValidCall(normalizeCall(call)) ? call : { ...call, chatModel: null };
    merged.set(previous, {
      ...previous, ...newest,
      responseId: id || responseId(previous),
      executionId: call.executionId || call.execution_id || previous.executionId,
      stepIndices: call.stepIndices?.length ? call.stepIndices
        : call.step_indices?.length ? call.step_indices : previous.stepIndices,
      timestampMs: call.timestampMs ?? previous.timestampMs,
      dateKey: call.dateKey || previous.dateKey,
      orchestrator: call.orchestrator ?? previous.orchestrator
    });
  }
  return [...merged.values()].sort((a, b) =>
    (callStepIndex(a) ?? Infinity) - (callStepIndex(b) ?? Infinity));
}

function hasModelHint(modelInput) {
  if (!modelInput) return false;
  return Boolean(
    modelInput.modelDisplayName ||
      modelInput.responseModel ||
      modelInput.modelEnum ||
      modelInput.model ||
      Number(modelInput.modelNum) > 0
  );
}

function pickFirstValidModel(calls = []) {
  const normalized = (Array.isArray(calls) ? calls : []).map(normalizeCall).filter(Boolean);
  const firstValid = normalized.find((c) => isValidCall(c) && hasModelHint(c.modelInput));
  if (firstValid) return resolveModelIdentity(firstValid.modelInput);
  const firstAny = normalized.find((c) => hasModelHint(c.modelInput));
  if (firstAny) return resolveModelIdentity(firstAny.modelInput);
  return resolveModelIdentity(null);
}

function normalizeSubagentStatus(summary = {}) {
  const status = String(summary.status || '').toUpperCase();
  const killed = Boolean(summary.killed);
  const hasError = Boolean(summary.lastStepHasError || summary.hasErrorStep);

  if (status === 'CASCADE_RUN_STATUS_RUNNING' && !killed) return 'Running';
  if (
    status === 'CASCADE_RUN_STATUS_ERROR' ||
    status === 'CASCADE_RUN_STATUS_FAILED' ||
    (hasError && status !== 'CASCADE_RUN_STATUS_RUNNING')
  ) {
    return 'Error';
  }
  return 'Done';
}

function computeCompactionInfo(validCalls = [], checkpointCount = 0) {
  let prevPromptTokens = null;
  let maxStartStep = 0;
  const seenStartSteps = new Set();
  let maxCheckpointIdx = -1;
  let truncationHits = 0;
  const events = [];

  for (const call of Array.isArray(validCalls) ? validCalls : []) {
    const promptTokens = (call.inputTokens || 0) + (call.cacheReadTokens || 0);
    const startStep =
      Number.isInteger(call.startStepIndex) && call.startStepIndex > 0 ? call.startStepIndex : 0;
    const cpIdx =
      Number.isInteger(call.checkpointIndex) && call.checkpointIndex >= 0 ? call.checkpointIndex : null;

    if (cpIdx !== null && cpIdx > maxCheckpointIdx) {
      maxCheckpointIdx = cpIdx;
    }
    if (call.truncationReason) {
      truncationHits++;
    }

    if (startStep > maxStartStep) {
      maxStartStep = startStep;
      seenStartSteps.add(startStep);
      events.push({
        startStepIndex: startStep,
        beforeTokens: prevPromptTokens,
        afterTokens: promptTokens > 0 ? promptTokens : null,
        truncationReason: call.truncationReason || null,
        timestampMs: call.timestampMs ?? null
      });
    } else if (call.truncationReason && events.length === 0) {
      events.push({
        startStepIndex: startStep || null,
        beforeTokens: prevPromptTokens,
        afterTokens: promptTokens > 0 ? promptTokens : null,
        truncationReason: call.truncationReason,
        timestampMs: call.timestampMs ?? null
      });
    }

    if (promptTokens > 0) {
      prevPromptTokens = promptTokens;
    }
  }

  const count = Math.max(
    toNonNegInt(checkpointCount),
    seenStartSteps.size,
    maxCheckpointIdx >= 0 ? maxCheckpointIdx + 1 : 0,
    truncationHits
  );
  const lastEvent = events.length > 0 ? events[events.length - 1] : null;

  return {
    compacted: count > 0,
    count,
    lastBeforeTokens: lastEvent ? lastEvent.beforeTokens : null,
    lastAfterTokens: lastEvent ? lastEvent.afterTokens : null,
    lastTruncationReason: lastEvent ? lastEvent.truncationReason : null,
    lastStartStepIndex: lastEvent ? lastEvent.startStepIndex : null
  };
}

function computeContextTrend(rawCalls, checkpointSteps = []) {
  const points = [];
  let checkpoint = 0;
  let previous = null;
  let previousModel = null;
  let startStep = 0;
  let checkpointIndex = -1;
  const addCheckpoint = (inferred = false) =>
    points.push({ kind: 'checkpoint', beforeTokens: previous?.tokens ?? null, inferred });
  for (const call of rawCalls.map(normalizeCall).filter(Boolean)) {
    const { stepIndex } = call;
    const tokens = call.inputTokens + call.cacheReadTokens;
    if (!tokens || (checkpointSteps.length && stepIndex === null)) continue;
    while (checkpoint < checkpointSteps.length && checkpointSteps[checkpoint] < stepIndex) {
      addCheckpoint();
      checkpoint++;
    }
    if (checkpointSteps[checkpoint] === stepIndex) continue;
    if (!checkpointSteps.length && previous &&
        ((call.startStepIndex ?? 0) > startStep || (call.checkpointIndex ?? -1) > checkpointIndex)) addCheckpoint(true);
    startStep = Math.max(startStep, call.startStepIndex ?? 0);
    checkpointIndex = Math.max(checkpointIndex, call.checkpointIndex ?? -1);
    const identity = resolveCallModel(call, null);
    const model = identity?.displayNameWithEffort || null;
    const point = {
      kind: 'sample', tokens, model, timestampMs: call.timestampMs > 0 ? call.timestampMs : null,
      afterCheckpoint: points.at(-1)?.kind === 'checkpoint',
      modelChanged: Boolean(model && previousModel && model !== previousModel)
    };
    if (model) previousModel = model;
    points.push(point);
    previous = point;
  }
  while (checkpoint < checkpointSteps.length) {
    addCheckpoint();
    checkpoint++;
  }
  return points.slice(-40);
}

function computeSessionStats(input = {}) {
  const rawCalls = Array.isArray(input.calls) ? input.calls : [];
  const normalized = rawCalls.map(normalizeCall).filter(Boolean);
  const validCalls = normalized.filter(isValidCall);

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let ttftSumMs = 0;
  let ttftCount = 0;
  let streamOutputTokens = 0;
  let streamSumMs = 0;
  let modelTimeMs = 0;

  for (const call of validCalls) {
    inputTokens += call.inputTokens;
    outputTokens += call.outputTokens;
    cacheReadTokens += call.cacheReadTokens;
    cacheWriteTokens += call.cacheWriteTokens;

    if (call.ttftMs !== null && call.ttftMs >= 0) {
      ttftSumMs += call.ttftMs;
      ttftCount++;
      modelTimeMs += call.ttftMs;
    }
    if (call.streamingMs !== null && call.streamingMs >= 0) {
      modelTimeMs += call.streamingMs;
      if (call.streamingMs > 0 && call.outputTokens > 0) {
        streamOutputTokens += call.outputTokens;
        streamSumMs += call.streamingMs;
      }
    }
  }

  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const promptTotal = inputTokens + cacheReadTokens;
  const cacheHitRate = promptTotal > 0 ? cacheReadTokens / promptTotal : null;
  const avgTtftMs = ttftCount > 0 ? ttftSumMs / ttftCount : null;
  const outputSpeedTps = streamSumMs > 0 ? streamOutputTokens / (streamSumMs / 1000) : null;

  const latestValid = validCalls.length > 0 ? validCalls[validCalls.length - 1] : null;
  const checkpoint = input.lastCheckpointStep;
  let measurement = latestValid;
  if (Number.isInteger(checkpoint)) {
    const measuredAfter = (call) => call?.stepIndex > checkpoint && call.inputTokens + call.cacheReadTokens > 0;
    measurement = validCalls.findLast(measuredAfter) ||
      (input.storedCalls || []).map(normalizeCall).findLast(measuredAfter);
  }
  const awaitingMeasurement = Number.isInteger(checkpoint) && !measurement;
  const currentContextTokens = awaitingMeasurement ? null : measurement ? measurement.inputTokens + measurement.cacheReadTokens : 0;
  let callMaxContextTokens = measurement?.maxContextTokens || latestValid?.maxContextTokens || null;
  if (!callMaxContextTokens) {
    for (let i = validCalls.length - 1; i >= 0; i--) {
      if (validCalls[i].maxContextTokens) {
        callMaxContextTokens = validCalls[i].maxContextTokens;
        break;
      }
    }
  }
  const effectiveContextLimit =
    Number.isFinite(Number(input.contextLimit)) && Number(input.contextLimit) > 0
      ? Number(input.contextLimit)
      : callMaxContextTokens;
  const primaryModel = pickFirstValidModel(rawCalls);
  const latestModel = latestValid ? resolveModelIdentity(latestValid.modelInput) : primaryModel;
  const cost = calculateSessionCost(validCalls, primaryModel);
  const compaction = computeCompactionInfo(validCalls, input.checkpointCount);
  const waterline = computeContextWaterline(currentContextTokens, effectiveContextLimit);
  if (awaitingMeasurement) {
    Object.assign(waterline, { usedTokens: null, ratio: null, percent: null, level: 'unknown', awaitingMeasurement: true });
  }

  return {
    conversationId: input.conversationId || '',
    title: input.title || '',
    turns: toNonNegInt(input.turns),
    steps: validCalls.length,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    cacheHitRate,
    avgTtftMs,
    outputSpeedTps,
    modelTimeMs,
    currentContextTokens,
    waterline,
    compaction,
    primaryModel,
    latestModel,
    cost
  };
}

function combineSessionWithSubagents(mainStats, subagents = []) {
  const list = Array.isArray(subagents) ? subagents : [];
  let runningCount = 0;
  let subagentTokens = 0;
  let combinedCostUsd = mainStats.cost?.priced ? mainStats.cost.costUsd : 0;
  let anyPriced = Boolean(mainStats.cost?.priced);
  let unpricedTokens = mainStats.cost?.unpricedTokens ?? (mainStats.cost?.priced ? 0 : mainStats.totalTokens || 0);

  const items = list.map((sub) => {
    const status = sub.normalizedStatus || normalizeSubagentStatus(sub);
    if (status === 'Running') runningCount++;
    const tokens = toNonNegInt(sub.totalTokens);
    subagentTokens += tokens;

    const subCost = sub.cost || { priced: false, costUsd: null };
    if (subCost.priced && subCost.costUsd !== null) {
      combinedCostUsd += subCost.costUsd;
      anyPriced = true;
    }
    unpricedTokens += subCost.unpricedTokens ?? (subCost.priced ? 0 : tokens);

    return {
      conversationId: sub.conversationId || '',
      title: sub.title || sub.role || sub.typeName || 'Subagent',
      kind: sub.kind || 'subagent',
      status,
      modelDisplayName: sub.primaryModel?.displayName || sub.modelDisplayName || 'Unknown',
      totalTokens: tokens,
      currentContextTokens: sub.waterline?.awaitingMeasurement ? null : toNonNegInt(sub.currentContextTokens),
      waterline: sub.waterline || computeContextWaterline(sub.currentContextTokens || 0, sub.contextLimit ?? null),
      cost: subCost
    };
  });

  const totalTokens = (mainStats.totalTokens || 0) + subagentTokens;
  const totalCount = items.length;

  return {
    main: mainStats,
    totalTokens,
    totalCost: {
      priced: anyPriced,
      costUsd: anyPriced ? combinedCostUsd : null,
      hasUnpriced: unpricedTokens > 0,
      unpricedTokens,
      label: anyPriced ? null : 'Unpriced'
    },
    subagentSummary: {
      runningCount,
      totalCount,
      hasRunning: runningCount > 0,
      badgeText: totalCount === 0 ? '0' : `${runningCount}/${totalCount}`,
      items
    }
  };
}

module.exports = {
  parseDurationMsInput,
  toLocalDateKey,
  normalizeCall,
  mergeConversationCalls,
  callStepIndex,
  isValidCall,
  pickFirstValidModel,
  normalizeSubagentStatus,
  computeCompactionInfo,
  computeContextTrend,
  computeSessionStats,
  combineSessionWithSubagents
};
