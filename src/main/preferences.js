'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const themes = ['auto', 'light', 'dark', 'pink', 'green'];
const base = process.platform === 'win32' ? process.env.LOCALAPPDATA || os.homedir()
  : path.join(os.homedir(), 'Library', 'Application Support');
const directory = path.join(base, 'AGY Liquid Monitor');
const file = path.join(directory, 'appearance.json');

function validate(settings) {
  const { theme, opacity, blurStrength } = settings || {};
  if (!themes.includes(theme) || !Number.isInteger(opacity) || opacity < 35 || opacity > 100 ||
    !Number.isInteger(blurStrength) || blurStrength < 0 || blurStrength > 100) {
    throw new Error('无效的外观设置。');
  }
  return { theme, opacity, blurStrength };
}

function readAppearance() {
  try {
    return validate(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

function saveAppearance(settings) {
  const appearance = validate(settings);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, 'appearance-' + randomUUID() + '.tmp');
  try {
    fs.writeFileSync(temporary, JSON.stringify(appearance), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return appearance;
}

module.exports = { themes, readAppearance, saveAppearance };
