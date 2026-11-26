'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../ui');
const readUI = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const geminiFont = () => fs.readFileSync(path.join(root, 'fonts/gemini.ttf')).toString('base64');

function readStyle() {
  return readUI('style.css').replace('/* GEMINI_SOURCE */', `url(data:font/ttf;base64,${geminiFont()}) format("truetype")`);
}

function hudSource() {
  return `(() => {
    const stylesheet = ${JSON.stringify(readStyle() + '\n' + readUI('hud.css'))};
    ${readUI('views.js')}
    ${readUI('interaction.js')}
    ${readUI('appearance.js')}
    ${readUI('hud.js')}
    mountLiquidMonitor(window.agyLiquidMonitor, stylesheet, ${JSON.stringify(geminiFont())});
  })()`;
}

module.exports = { readStyle, hudSource };
