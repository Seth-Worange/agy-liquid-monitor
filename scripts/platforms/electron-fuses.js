'use strict';

const fs = require('node:fs');

const marker = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');

function assertAsarIntegrityDisabled(binary, universal = false) {
  const bytes = fs.readFileSync(binary);
  const states = [];
  for (let index = bytes.indexOf(marker); index !== -1; index = bytes.indexOf(marker, index + marker.length)) {
    const start = index + marker.length;
    states.push(bytes[start] === 1 && bytes[start + 1] >= 5 && bytes[start + 6] === 48);
  }
  if (!states.length || (!universal && states.length !== 1) || !states.every(Boolean)) {
    throw new Error('此客户端启用了 ASAR 完整性验证，或无法确认其状态。当前版本无法安装状态栏。');
  }
}

module.exports = { assertAsarIntegrityDisabled };
