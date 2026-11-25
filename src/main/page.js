'use strict';

const fs = require('node:fs');
const path = require('node:path');

function renderPage({ demo = false } = {}) {
  const read = (name) => fs.readFileSync(path.join(__dirname, '..', 'ui', name), 'utf8');
  let html = read('index.html').replace('/* CSS */', () => read('style.css'));
  if (demo) {
    const { demoData } = require('../../scripts/demo');
    const fixture = JSON.stringify(demoData()).replaceAll('<', '\\u003c');
    html = html.replace('<body>', () => `<body data-demo="true"><script>
      const demoFixture = ${fixture};
      window.monitorDemo = ({ ids, period, date }) => ({
        updatedAt: Date.now(),
        panels: (ids.length ? ids : [demoFixture.menu[0].id]).map((id) =>
          demoFixture.panels.find((panel) => panel.main.conversationId === id)).filter(Boolean),
        menu: demoFixture.menu,
        quota: demoFixture.quota,
        usage: { ...demoFixture.reports[period], ...demoFixture.days[date] }
      });
    </script>`);
  }
  return html.replace('/* JAVASCRIPT */', () => read('app.js'));
}

module.exports = { renderPage };
