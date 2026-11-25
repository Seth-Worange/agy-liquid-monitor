'use strict';

const readline = require('node:readline');
const { createMonitor } = require('./monitor');
const { renderPage } = require('./page');
const { version } = require('../../package.json');

const monitor = createMonitor();
const uri = 'ui://agy-liquid-monitor/dashboard.html';
const mimeType = 'text/html;profile=mcp-app';
const resource = { uri, name: 'AGY Liquid Monitor', mimeType };
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const tools = [
  {
    name: 'open_monitor',
    title: 'AGY Liquid Monitor',
    description: 'Open the local Antigravity usage, quota, session and context dashboard.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: readOnly,
    _meta: {
      ui: { resourceUri: uri },
      'com.google.antigravity/ui': {
        entrypoints: [{ type: 'global', title: 'Liquid Monitor' }, { type: 'aux_pane', title: 'Liquid Monitor' }]
      }
    }
  },
  {
    name: 'monitor_snapshot',
    description: 'Refresh aggregated, read-only local Antigravity metrics for the dashboard.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        ids: { type: 'array', maxItems: 4, items: { type: 'string' } },
        period: { enum: ['7D', '30D', 'ALL'] },
        date: { type: ['string', 'null'] },
        context: { type: 'boolean' },
        force: { type: 'boolean' }
      }
    },
    annotations: readOnly,
    _meta: { ui: { visibility: ['app'] } }
  }
];

async function handle(method, params = {}) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'].includes(params.protocolVersion)
          ? params.protocolVersion : '2025-11-25',
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'agy-liquid-monitor', version }
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools };
    case 'resources/list':
      return { resources: [resource] };
    case 'resources/templates/list':
      return { resourceTemplates: [] };
    case 'resources/read':
      if (params.uri !== uri) throw Object.assign(new Error('Unknown dashboard resource'), { code: -32002 });
      return { contents: [{ uri, mimeType, text: renderPage() }] };
    case 'tools/call':
      if (params.name === 'open_monitor') {
        return { content: [{ type: 'text', text: 'Liquid Monitor is available in Antigravity App → Plugins.' }] };
      }
      if (params.name === 'monitor_snapshot') {
        try {
          return {
            content: [{ type: 'text', text: 'Local dashboard metrics refreshed.' }],
            structuredContent: await monitor.snapshot(params.arguments || {})
          };
        } catch {
          return { isError: true, content: [{ type: 'text', text: '暂时无法读取本地用量。请刷新重试。' }] };
        }
      }
      throw Object.assign(new Error('Unknown tool'), { code: -32602 });
    default:
      throw Object.assign(new Error('Method not found'), { code: -32601 });
  }
}

function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
}

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    send({ id: message?.id ?? null, error: { code: -32600, message: 'Invalid request' } });
    return;
  }
  if (!Object.hasOwn(message, 'id')) return;
  try {
    send({ id: message.id, result: await handle(message.method, message.params) });
  } catch (error) {
    send({ id: message.id, error: { code: error.code || -32603, message: error.message } });
  }
});
