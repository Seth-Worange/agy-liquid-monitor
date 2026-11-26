'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readStyle } = require('./ui-source');

function renderPage({ demo = false } = {}) {
  const read = (name) => fs.readFileSync(path.join(__dirname, '..', 'ui', name), 'utf8');
  let html = read('index.html').replace('/* CSS */', () => readStyle())
    .replace('<!-- LOGO -->', () => read('logo.svg'));
  if (demo) {
    const { demoData } = require('../../scripts/demo');
    const fixture = JSON.stringify(demoData()).replaceAll('<', '\\u003c');
    html = html.replace('<body>', () => `<body data-demo="true"><script>
      const demoFixture = ${fixture};
      window.monitorDemo = ({ ids, period, date, fallback }) => ({
        updatedAt: Date.now(),
        panels: (ids.length || fallback === false ? ids : [demoFixture.menu[0].id]).map((id) =>
          demoFixture.panels.find((panel) => panel.main.conversationId === id)).filter(Boolean),
        menu: demoFixture.menu,
        quota: demoFixture.quota,
        usage: { ...demoFixture.reports[period], ...demoFixture.days[date] }
      });
    </script>`);
  }
  return html.replace('/* JAVASCRIPT */', () => ['views.js', 'interaction.js', 'appearance.js', 'app.js'].map(read).join('\n'));
}

module.exports = { renderPage };
