'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { CONTEXT_CATEGORIES, computeContextBreakdown } = require('../core/context');
const { buildQuotaSnapshot, lookupContextLimit } = require('../core/quota');
const { resolveModelIdentity } = require('../core/pricing');
const { callStepIndex, combineSessionWithSubagents, computeSessionStats, normalizeSubagentStatus } = require('../core/session');
const { computeUsageReport } = require('../core/usage');
const { liveHub, readHub } = require('./hub');
const { readAppearance } = require('./preferences');
const { DEFAULT_DATA_DIR, scanConversationsIncremental, readConversationDb } = require('./sqlite-reader');

const sessionId = /^[a-z0-9][a-z0-9-]{0,127}$/i;
// Expire quota before the HUD's next 12-second poll, while deduplicating nearby requests.
const accountMaxAgeMs = 10000;

function createMonitor(dataDir = DEFAULT_DATA_DIR) {
  const entries = new Map();
  let scan;
  let scannedAt = 0;
  let account;
  let fetchingAccount;

  function history(force) {
    if (!scan || force || Date.now() - scannedAt > 10000) {
      scan = scanConversationsIncremental({ dataDir, entries });
      scannedAt = Date.now();
    }
    return scan;
  }

  async function readAccount(hub, force) {
    if (!hub) {
      account = null;
      return null;
    }
    const key = `${hub.pid}:${hub.port}:${hub.modified}`;
    if (!force && account?.key === key && Date.now() - account.at < accountMaxAgeMs) return account;
    if (fetchingAccount?.key === key) return fetchingAccount.promise;
    const promise = (async () => {
      const [quotaSummary, userStatus] = await Promise.allSettled([
        readHub(hub, 'RetrieveUserQuotaSummary'),
        readHub(hub, 'GetUserStatus')
      ]);
      return account = {
        key, at: Date.now(), quotaSummaryRes: quotaSummary.value, userStatusRes: userStatus.value
      };
    })();
    fetchingAccount = { key, promise };
    try {
      return await promise;
    } finally {
      if (fetchingAccount?.promise === promise) fetchingAccount = null;
    }
  }

  async function readLiveCalls(hub, id, includeMessages) {
    if (!hub) return [];
    try {
      const reply = await readHub(hub, 'GetCascadeTrajectoryGeneratorMetadata', {
        cascadeId: id, generatorMetadataOffset: 0, includeMessages
      });
      return Array.isArray(reply.generatorMetadata) ? reply.generatorMetadata.filter((item) => item?.chatModel) : [];
    } catch {
      return [];
    }
  }

  function statsFor(meta, database, calls, configs) {
    const input = {
      conversationId: meta.conversationId, title: meta.title,
      turns: database?.turns || 0, checkpointCount: database?.checkpointCount || 0,
      lastCheckpointStep: database?.lastCheckpointStep, calls,
      storedCalls: calls === database?.calls ? [] : database?.calls
    };
    const stats = computeSessionStats(input);
    const limit = lookupContextLimit(stats.latestModel, configs);
    const knownModel = !stats.steps && meta.subagentModelNum
      ? resolveModelIdentity({ modelNum: meta.subagentModelNum }) : stats.primaryModel;
    return {
      ...(stats.waterline.contextLimit || !limit ? stats : computeSessionStats({ ...input, contextLimit: limit })),
      primaryModel: knownModel,
      kind: meta.kind,
      normalizedStatus: normalizeSubagentStatus({ ...meta, lastStepHasError: database?.lastStepHasError })
    };
  }

  async function snapshot(query = {}) {
    const now = Date.now();
    const force = query.force === true;
    const period = ['7D', '30D', 'ALL'].includes(query.period) ? query.period : '30D';
    const date = typeof query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(query.date) ? query.date : null;
    const { sessions, summaries, stats } = history(force);
    const byId = new Map(sessions.map((s) => [s.conversationId, s]));
    const main = new Map(summaries.list.filter((row) => !row.isChild || row.rootConversationId === row.conversationId)
      .map((row) => [row.conversationId, row]));
    for (const row of sessions) if (!row.isChild && !main.has(row.conversationId)) main.set(row.conversationId, row);
    const available = [...main.values()].filter((row) => sessionId.test(row.conversationId))
      .sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);
    const requested = Array.isArray(query.ids) ? query.ids.slice(0, 4) : [];
    const selected = [...new Set(requested)].filter((id) => typeof id === 'string' && sessionId.test(id) && main.has(id));
    const recent = available.slice(0, 150);
    const visible = new Set(recent.map((row) => row.conversationId));
    const menu = [...recent, ...selected.filter((id) => !visible.has(id)).map((id) => main.get(id))].map((row) => ({
      id: row.conversationId, title: String(row.title).slice(0, 100)
    }));
    if (!selected.length && menu.length && query.fallback !== false) selected.push(menu[0].id);

    const hub = liveHub(dataDir);
    const accountPromise = readAccount(hub, force);
    const modelsPromise = Promise.all(selected.map((id) => readLiveCalls(hub, id, false)));
    const contextPromise = query.context === true
      ? Promise.all(selected.map((id) => readLiveCalls(hub, id, true)))
      : null;
    const [identity, models, liveContexts] = await Promise.all([accountPromise, modelsPromise, contextPromise]);
    const quota = buildQuotaSnapshot({ ...identity, nowMs: Date.now(), updatedAtMs: identity?.at });
    const activeChildren = selected.flatMap((id) => (summaries.childrenByRoot.get(id) || [])
      .filter((child) => child.conversationId !== id && child.normalizedStatus === 'Running' &&
        sessionId.test(child.conversationId))).slice(0, 4);
    const childCalls = new Map(await Promise.all(activeChildren.map(async ({ conversationId }) =>
      [conversationId, await readLiveCalls(hub, conversationId, false)])));
    const panels = selected.map((id, index) => {
      const meta = main.get(id);
      const database = byId.get(id);
      const liveCalls = models[index];
      const mainStats = statsFor(meta, database, liveCalls.length ? liveCalls : database?.calls || [], quota.clientModelConfigs);
      const children = (summaries.childrenByRoot.get(id) || [])
        .filter((child) => child.conversationId !== id)
        .map((child) => {
          const stored = byId.get(child.conversationId);
          const live = childCalls.get(child.conversationId);
          return statsFor(child, stored, live?.length ? live : stored?.calls || [], quota.clientModelConfigs);
        });
      let context = null;
      if (query.context === true) {
        const detailed = (liveContexts?.[index] || []).findLast((call) => {
          if (Number.isInteger(database?.lastCheckpointStep) && !(callStepIndex(call) > database.lastCheckpointStep)) return false;
          const { chatModel } = call;
          return (chatModel.promptSections || chatModel.prompt_sections)?.length ||
            chatModel.tools?.length || (chatModel.messagePrompts || chatModel.message_prompts)?.length;
        });
        let payload = detailed?.chatModel;
        if (!payload && database && !mainStats.waterline.awaitingMeasurement) {
          try {
            payload = readConversationDb(path.join(dataDir, 'conversations', `${id}.db`),
              { includeContext: true }).contextChatModel;
          } catch {
            // During app updates or checkpoints, the detail may be temporarily unavailable.
          }
        }
        context = payload
          ? computeContextBreakdown(payload, { contextLimit: mainStats.waterline.contextLimit })
          : { breakdownAvailable: false, categories: CONTEXT_CATEGORIES };
      }
      return { ...combineSessionWithSubagents(mainStats, children), context, live: Boolean(liveCalls.length) };
    });

    const activeQuota = buildQuotaSnapshot({
      ...identity, nowMs: Date.now(), updatedAtMs: identity?.at, currentModel: query.currentModel || panels[0]?.main.latestModel
    });
    const { name, planFullName, planBadge, initials } = activeQuota.profile;
    return {
      updatedAt: now,
      appearance: readAppearance(),
      menu,
      panels,
      usage: computeUsageReport(sessions, { period, nowMs: now, selectedDateKey: date }),
      quota: {
        online: Boolean(identity?.userStatusRes || identity?.quotaSummaryRes),
        profile: { name, planFullName, planBadge, initials },
        summaryRings: activeQuota.summaryRings,
        pools: activeQuota.pools
      },
      sources: { present: fs.existsSync(dataDir), databases: stats.totalDbs, errors: stats.errors.length }
    };
  }
  return { snapshot };
}

module.exports = { createMonitor };
