'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function liveHub(dataDir) {
  const dir = path.join(dataDir, 'daemon');
  const hubs = [];
  let files;
  try {
    files = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const file of files) {
    if (!file.isFile() || !/^hub_\d+\.json$/i.test(file.name)) continue;
    try {
      const filePath = path.join(dir, file.name);
      const stat = fs.statSync(filePath);
      if (stat.size > 4096) continue;
      const { pid, httpPort, csrfToken } = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!pidIsAlive(pid) || !Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65535) continue;
      if (typeof csrfToken !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(csrfToken)) continue;
      hubs.push({ pid, port: httpPort, csrfToken, modified: stat.mtimeMs });
    } catch {
      // The hub can replace its descriptor while starting.
    }
  }
  return hubs.sort((a, b) => b.modified - a.modified)[0] || null;
}

const readMethods = new Set([
  'GetUserStatus',
  'RetrieveUserQuotaSummary',
  'GetCascadeTrajectoryGeneratorMetadata'
]);

async function readHub(hub, method, args = {}) {
  if (!readMethods.has(method)) throw new Error('Unsupported read-only method');
  const body = JSON.stringify(args);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port: hub.port,
      path: `/exa.language_server_pb.LanguageServerService/${method}`,
      method: 'POST',
      agent: false,
      signal: AbortSignal.timeout(5000),
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Connect-Protocol-Version': '1',
        'x-codeium-csrf-token': hub.csrfToken
      }
    }, async (response) => {
      try {
        if (response.statusCode !== 200) {
          response.resume();
          throw new Error(`Antigravity RPC returned HTTP ${response.statusCode}`);
        }
        const chunks = [];
        let total = 0;
        for await (const chunk of response) {
          total += chunk.length;
          if (total > 16 * 1024 * 1024) throw new Error('Antigravity RPC response too large');
          chunks.push(chunk);
        }
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
    request.end(body);
  });
}

module.exports = { liveHub, readHub };
