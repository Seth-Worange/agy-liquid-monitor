'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { pathToFileURL } = require('node:url');

const { parseRawSummary, parseStepMetadata, parseGenMetadata, parseUserInputRoute, parseOrchestrationEvent } = require('../core/pb');
const { resolveModelIdentity } = require('../core/pricing');
const { computeContextBreakdown } = require('../core/context');
const {
  toLocalDateKey,
  callStepIndex,
  pickFirstValidModel,
  normalizeSubagentStatus
} = require('../core/session');

const DEFAULT_DATA_DIR = path.join(os.homedir(), '.gemini', 'antigravity');

function toSqliteFileUri(dbPath, immutable) {
  const url = pathToFileURL(path.resolve(dbPath));
  url.searchParams.set('mode', 'ro');
  if (immutable) url.searchParams.set('immutable', '1');
  return url.href;
}

function hasActiveWal(dbPath) {
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  try {
    if (!fs.existsSync(shmPath) || !fs.existsSync(walPath)) return false;
    return fs.statSync(walPath).size > 0;
  } catch {
    return false;
  }
}

/**
 * Open a SQLite database strictly read-only in a WAL-safe manner.
 */
function openReadOnlyDb(dbPath) {
  const immutable = !hasActiveWal(dbPath);
  const uri = toSqliteFileUri(dbPath, immutable);
  return new DatabaseSync(uri, { readOnly: true, enableDoubleQuotedStringLiterals: false });
}

function parseSqlTimestampMs(value) {
  if (!value || typeof value !== 'string') return null;
  const isoLike = value.trim().replace(' ', 'T');
  const ms = Date.parse(isoLike);
  return Number.isFinite(ms) ? ms : null;
}

function firstLine(text, maxLen = 80) {
  const line = String(text || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find(Boolean) || '';
  return line.length > maxLen ? `${line.slice(0, maxLen - 1)}…` : line;
}

/**
 * Read conversation_summaries.db and classify main, regular subagent, and workflow child sessions.
 */
function readConversationSummaries(dataDir = DEFAULT_DATA_DIR) {
  const dbPath = path.join(dataDir, 'conversation_summaries.db');
  const byId = new Map();
  const list = [];
  const childrenByRoot = new Map();

  if (!fs.existsSync(dbPath)) {
    return { byId, list, childrenByRoot };
  }

  const db = openReadOnlyDb(dbPath);
  try {
    const rows = db
      .prepare(
        `SELECT conversation_id, title, preview, step_count, last_modified_time,
                status, project_id, agent_name, parent_conversation_id,
                nesting_depth, killed, last_user_input_time, raw_summary
         FROM conversation_summaries`
      )
      .all();

    for (const r of rows) {
      const id = r.conversation_id;
      const pbInfo = r.raw_summary ? parseRawSummary(r.raw_summary) : {};
      const parentId = r.parent_conversation_id || pbInfo.parentConversationId || '';
      const rootFromPb = pbInfo.rootConversationId || '';
      const agentName = r.agent_name || pbInfo.subagentSpec?.typeName || '';
      const nestingDepth = Number(r.nesting_depth) || 0;

      let kind = 'main';
      if (nestingDepth > 0 || parentId) {
        kind = 'subagent';
      } else if (agentName) {
        kind = 'workflow';
      }

      let rootConversationId = id;
      if (kind !== 'main') {
        rootConversationId = rootFromPb || parentId || id;
      }

      const role = pbInfo.subagentSpec?.role || '';
      const displayTitle =
        r.title ||
        role ||
        pbInfo.rawTitle ||
        firstLine(r.preview) ||
        agentName ||
        id.slice(0, 8);

      const lastModifiedMs = parseSqlTimestampMs(r.last_modified_time) || 0;
      const item = {
        conversationId: id,
        kind,
        isChild: kind !== 'main',
        title: displayTitle,
        role,
        agentName,
        parentConversationId: parentId || (kind === 'workflow' && rootConversationId !== id ? rootConversationId : ''),
        rootConversationId,
        status: r.status || '',
        killed: Boolean(r.killed),
        normalizedStatus: normalizeSubagentStatus({ status: r.status, killed: Boolean(r.killed) }),
        stepCount: Number(r.step_count) || 0,
        lastModifiedMs,
        subagentModelNum: pbInfo.subagentSpec?.modelEnum || null
      };

      byId.set(id, item);
      list.push(item);

      if (item.isChild && item.rootConversationId) {
        const kids = childrenByRoot.get(item.rootConversationId) || [];
        kids.push(item);
        childrenByRoot.set(item.rootConversationId, kids);
      }
    }
  } finally {
    db.close();
  }

  return { byId, list, childrenByRoot };
}

/**
 * Read a single conversations/<id>.db file read-only.
 */
function readConversationDb(dbPath, { includeContext = false, fallbackTimestampMs = null } = {}) {
  const db = openReadOnlyDb(dbPath);
  try {
    const stepRows = db
      .prepare('SELECT idx, step_type, status, metadata, error_details FROM steps ORDER BY idx ASC')
      .all();
    const hasStepPayload = db.prepare("SELECT 1 FROM pragma_table_info('steps') WHERE name = 'step_payload'").get();
    const routes = hasStepPayload
      ? db.prepare('SELECT idx, step_payload FROM steps WHERE step_type = 14 ORDER BY idx ASC').all().flatMap((row) => {
        const route = parseUserInputRoute(row.step_payload);
        return route ? [{ stepIndex: row.idx, ...route }] : [];
      }) : [];

    let turns = 0;
    let lastUserStep = null;
    let checkpointCount = 0;
    const checkpointSteps = [];
    let errorStepCount = 0;
    let lastStepHasError = false;
    const stepTimeByIdx = new Map();

    for (let i = 0; i < stepRows.length; i++) {
      const s = stepRows[i];
      const stepType = Number(s.step_type);
      if (stepType === 14) {
        turns++;
        lastUserStep = s.idx;
      }
      if (stepType === 23) checkpointCount++;
      const hasErr = Boolean(s.error_details && s.error_details.length > 0);
      if (stepType === 23 && Number(s.status) === 3 && !hasErr) checkpointSteps.push(s.idx);
      if (hasErr) errorStepCount++;
      if (i === stepRows.length - 1) lastStepHasError = hasErr;
      if (s.metadata) {
        const meta = parseStepMetadata(s.metadata);
        if (meta.createdAtMs !== null) stepTimeByIdx.set(s.idx, meta.createdAtMs);
      }
    }

    const lastCheckpointStep = checkpointSteps.at(-1) ?? null;
    const gmRows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all();
    const calls = [];
    let lastContextGmIdx = null;
    let lastKnownTs = fallbackTimestampMs;

    for (const gm of gmRows) {
      if (!gm.data) continue;
      const parsed = parseGenMetadata(gm.data, { includeContext: false });
      const cm = parsed.chatModel;
      if (!cm) continue;

      const stepIndex = callStepIndex(parsed);
      if (cm.hasContextPayload && (lastCheckpointStep === null || stepIndex > lastCheckpointStep)) lastContextGmIdx = gm.idx;

      let timestampMs = null;
      for (const si of parsed.stepIndices) {
        if (stepTimeByIdx.has(si)) {
          timestampMs = stepTimeByIdx.get(si);
          break;
        }
      }
      if (timestampMs === null) timestampMs = lastKnownTs;
      else lastKnownTs = timestampMs;

      calls.push({
        idx: gm.idx,
        executionId: parsed.executionId,
        responseId: cm.usage.responseId,
        stepIndices: parsed.stepIndices,
        orchestrator: parsed.orchestrator,
        stepIndex,
        timestampMs,
        dateKey: timestampMs !== null ? toLocalDateKey(timestampMs) : null,
        modelNum: cm.modelNum,
        modelEnum: cm.modelEnum,
        responseModel: cm.responseModel,
        modelDisplayName: cm.modelDisplayName,
        inputTokens: cm.usage.inputTokens,
        outputTokens: cm.usage.outputTokens,
        cacheReadTokens: cm.usage.cacheReadTokens,
        cacheWriteTokens: cm.usage.cacheWriteTokens,
        thinkingOutputTokens: cm.usage.thinkingOutputTokens,
        responseOutputTokens: cm.usage.responseOutputTokens,
        ttftMs: cm.ttftMs,
        streamingMs: cm.streamingMs,
        maxContextTokens: cm.maxContextTokens ?? null,
        startStepIndex: cm.startStepIndex ?? null,
        checkpointIndex: cm.checkpointIndex ?? null,
        truncationReason: cm.truncationReason ?? null
      });
    }

    let contextChatModel = null;
    if (includeContext && lastContextGmIdx !== null) {
      const ctxRow = db.prepare('SELECT data FROM gen_metadata WHERE idx = ?').get(lastContextGmIdx);
      if (ctxRow && ctxRow.data) {
        contextChatModel = parseGenMetadata(ctxRow.data, { includeContext: true }).chatModel;
      }
    }

    return {
      turns,
      lastUserStep,
      checkpointCount,
      checkpointSteps,
      lastCheckpointStep,
      lastStepIndex: stepRows.at(-1)?.idx ?? null,
      routes,
      errorStepCount,
      lastStepHasError,
      calls,
      contextChatModel
    };
  } finally {
    db.close();
  }
}

function getDbFingerprint(dbPath) {
  const st = fs.statSync(dbPath);
  let walMtime = 0;
  let walSize = 0;
  const walPath = `${dbPath}-wal`;
  try {
    if (fs.existsSync(walPath)) {
      const wst = fs.statSync(walPath);
      walMtime = wst.mtimeMs;
      walSize = wst.size;
    }
  } catch {}
  return `${st.mtimeMs}:${st.size}:${walMtime}:${walSize}`;
}

/**
 * Incrementally scan conversations/*.db using mtime+size+wal fingerprints.
 */
function scanConversationsIncremental({ dataDir = DEFAULT_DATA_DIR, entries = new Map() } = {}) {
  const startMs = Date.now();
  const summaries = readConversationSummaries(dataDir);
  const convDir = path.join(dataDir, 'conversations');

  let cacheHits = 0;
  let scanned = 0;
  const errors = [];

  const files = fs.existsSync(convDir)
    ? fs.readdirSync(convDir, { withFileTypes: true })
      .filter((file) => file.isFile() && /^[a-z0-9][a-z0-9-]{0,127}\.db$/i.test(file.name))
      .map((file) => file.name).sort()
    : [];
  const ids = new Set(files.map((file) => file.slice(0, -3)));
  for (const id of entries.keys()) if (!ids.has(id)) entries.delete(id);

  const sessions = [];

  for (const file of files) {
    const id = file.slice(0, -3);
    const dbPath = path.join(convDir, file);
    const sum = summaries.byId.get(id);

    let fp = null;
    try {
      fp = getDbFingerprint(dbPath);
    } catch (err) {
      errors.push({ conversationId: id, error: err.message });
      continue;
    }

    let dbData = null;
    const cached = entries.get(id);
    if (cached && cached.fingerprint === fp) {
      dbData = cached.data;
      cacheHits++;
    } else {
      try {
        const fallbackTs = sum?.lastModifiedMs || fs.statSync(dbPath).mtimeMs;
        dbData = readConversationDb(dbPath, { includeContext: false, fallbackTimestampMs: fallbackTs });
        entries.set(id, { fingerprint: fp, data: dbData });
        scanned++;
      } catch (err) {
        errors.push({ conversationId: id, error: err.message });
        continue;
      }
    }

    const calls = Array.isArray(dbData.calls) ? dbData.calls : [];
    const primaryModel = calls.length > 0
      ? pickFirstValidModel(calls)
      : resolveModelIdentity(sum?.subagentModelNum ? { modelNum: sum.subagentModelNum } : null);

    sessions.push({
      conversationId: id,
      kind: sum?.kind || 'main',
      isChild: sum ? sum.isChild : false,
      title: sum?.title || id.slice(0, 8),
      role: sum?.role || '',
      agentName: sum?.agentName || '',
      parentConversationId: sum?.parentConversationId || '',
      rootConversationId: sum?.rootConversationId || id,
      status: sum?.status || '',
      killed: sum?.killed || false,
      normalizedStatus: normalizeSubagentStatus({
        status: sum?.status,
        killed: sum?.killed,
        lastStepHasError: dbData.lastStepHasError
      }),
      lastModifiedMs: sum?.lastModifiedMs || fs.statSync(dbPath).mtimeMs,
      turns: dbData.turns || 0,
      lastUserStep: dbData.lastUserStep,
      errorStepCount: dbData.errorStepCount || 0,
      lastStepHasError: Boolean(dbData.lastStepHasError),
      checkpointCount: dbData.checkpointCount || 0,
      checkpointSteps: dbData.checkpointSteps,
      lastCheckpointStep: dbData.lastCheckpointStep ?? null,
      lastStepIndex: dbData.lastStepIndex,
      routes: dbData.routes,
      primaryModel,
      calls
    });
  }

  return {
    summaries,
    sessions,
    stats: {
      totalDbs: files.length,
      cacheHits,
      scanned,
      errors,
      elapsedMs: Date.now() - startMs
    }
  };
}

function readConversationContext(dataDir = DEFAULT_DATA_DIR, conversationId, { contextLimit = null } = {}) {
  const dbPath = path.join(dataDir, 'conversations', `${conversationId}.db`);
  if (!fs.existsSync(dbPath)) return null;
  const detail = readConversationDb(dbPath, { includeContext: true });
  if (!detail.contextChatModel) return null;
  return computeContextBreakdown(detail.contextChatModel, { contextLimit });
}

function readOrchestrationEvents(dbPath, afterStep) {
  const db = openReadOnlyDb(dbPath);
  try {
    const rows = db.prepare(`WITH last_input AS (SELECT MAX(idx) AS idx FROM steps WHERE step_type = 14)
      SELECT last_input.idx AS last_user_step, events.idx, events.step_payload
      FROM last_input LEFT JOIN steps AS events ON last_input.idx = ? AND events.idx > last_input.idx AND events.step_type = 101
      ORDER BY events.idx ASC`).all(afterStep);
    if (rows[0]?.last_user_step !== afterStep) return null;
    return rows.flatMap((row) => {
      const event = parseOrchestrationEvent(row.step_payload);
      return event ? [{ ...event, stepIndex: row.idx }] : [];
    });
  } finally {
    db.close();
  }
}

module.exports = {
  DEFAULT_DATA_DIR,
  toSqliteFileUri,
  hasActiveWal,
  openReadOnlyDb,
  parseSqlTimestampMs,
  readConversationSummaries,
  readConversationDb,
  readOrchestrationEvents,
  getDbFingerprint,
  scanConversationsIncremental,
  readConversationContext
};
