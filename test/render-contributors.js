// Renders the Contributors webview in headless Chrome, both themes, and asserts on the DOM.
// tsc never reads media/, so this is the only check the front end gets. Run: npm run test:webview
const Module = require('node:module');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!fs.existsSync(chrome)) {
  console.error(`Google Chrome not found at ${chrome}; set CHROME=/path/to/chrome`);
  process.exit(1);
}

// dist/ imports vscode at load time; stub just what html.ts touches.
const uri = (fsPath) => ({ fsPath, toString: () => 'file://' + fsPath });
const vscodeStub = { Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) } };
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  return request === 'vscode' ? vscodeStub : originalLoad.call(this, request, ...rest);
};
Math.random = () => 0.5; // stable nonce

const { setExtensionHome } = require('../dist/logView/extensionHome.js');
const { renderContributorsHtml } = require('../dist/contributors/html.js');
setExtensionHome(uri(repoRoot));

const webview = { asWebviewUri: (u) => u.toString(), cspSource: 'vscode-resource:' };

// Fixture: 20 weeks ending this week. Ann totals 192 commits over 13 weeks, Bao 96 over 8,
// claude 1 in the oldest week only - so ranks and the summary are fixed numbers.
const WEEK = 7 * 86400;
const FIRST_MONDAY = 4 * 86400;
const thisMonday = Math.floor((Math.floor(Date.now() / 1000) - FIRST_MONDAY) / WEEK) * WEEK + FIRST_MONDAY;
function weeks(count, valueAt) {
  const rows = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const value = valueAt(i);
    if (value) {
      rows.push([thisMonday - i * WEEK, value, value * 10, value * 3]);
    }
  }
  return rows;
}
const contributors = [
  { name: 'Ann Nguyen', email: 'ann@example.com', weeks: weeks(20, (i) => (i % 3 === 0 ? 0 : 5 + i)) },
  { name: 'Bao Tran', email: 'bao@example.com', weeks: weeks(20, (i) => (i < 8 ? 12 : 0)) },
  { name: 'claude', email: '', weeks: weeks(20, (i) => (i === 19 ? 1 : 0)) }
].map((c) => ({
  ...c,
  commits: c.weeks.reduce((sum, row) => sum + row[1], 0),
  additions: c.weeks.reduce((sum, row) => sum + row[2], 0),
  deletions: c.weeks.reduce((sum, row) => sum + row[3], 0)
}));
const state = { root: repoRoot, head: 'abc123', generatedAt: Date.now(), firstWeek: thisMonday - 19 * WEEK, contributors };

function renderTheme(theme, pageState, tag) {
  let html = renderContributorsHtml(webview, pageState);
  const nonce = /nonce="([^"]+)"/.exec(html)[1];
  // The shim must carry the page nonce or the CSP drops it, and then contributors.js throws
  // on its first line and the body stays empty - which reads as a blank page, not an error.
  const shim = `<script nonce="${nonce}">
    window.__errors = [];
    window.onerror = (message) => { window.__errors.push(String(message)); };
    window.acquireVsCodeApi = () => ({ getState: () => undefined, setState: () => {}, postMessage: () => {} });
    setTimeout(() => {
      const avatar = document.querySelector('.avatar');
      const bar = document.querySelector('rect.bar');
      let tooltip = null;
      if (bar) {
        const box = bar.getBoundingClientRect();
        bar.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: box.left + 1, clientY: box.top + 1 }));
        const node = document.getElementById('tooltip');
        tooltip = node && !node.hidden ? node.textContent : null;
      }
      document.title = JSON.stringify({
        tooltip,
        errors: window.__errors,
        cards: document.querySelectorAll('.contributor-card').length,
        bars: document.querySelectorAll('rect.bar').length,
        ranks: Array.from(document.querySelectorAll('.rank'), (n) => n.textContent),
        names: Array.from(document.querySelectorAll('.name'), (n) => n.textContent),
        summary: document.querySelector('.summary') ? document.querySelector('.summary').textContent : null,
        empty: document.querySelector('.empty') ? document.querySelector('.empty').textContent : null,
        error: document.querySelector('.banner.error') ? document.querySelector('.banner.error').textContent : null,
        loading: Boolean(document.querySelector('.progress.active')),
        avatarBg: avatar ? getComputedStyle(avatar).backgroundColor : null,
        barFill: bar ? getComputedStyle(bar).fill : null,
        bodyBg: getComputedStyle(document.body).backgroundColor
      });
    }, 300);
  </script>`;
  html = html.replace('<body>', `<body class="${theme}">`).replace('<script nonce', shim + '<script nonce');
  const file = path.join(os.tmpdir(), `gitrail-contributors-${theme}${tag ? '-' + tag : ''}.html`);
  fs.writeFileSync(file, html);
  const dom = execFileSync(chrome, [
    '--headless', '--disable-gpu', '--window-size=1200,900', '--virtual-time-budget=3000', '--dump-dom', 'file://' + file
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const title = /<title>(.*?)<\/title>/s.exec(dom)[1];
  return JSON.parse(title.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
}

for (const theme of ['vscode-dark', 'vscode-light']) {
  const result = renderTheme(theme, state);
  assert.deepEqual(result.errors, [], `${theme}: window.onerror fired`);
  assert.equal(result.cards, 3, `${theme}: one card per contributor at All time`);
  assert.deepEqual(result.ranks, ['#1', '#2', '#3'], `${theme}: ranks follow the sort`);
  assert.deepEqual(result.names, ['Ann Nguyen', 'Bao Tran', 'claude'], `${theme}: sorted by commits`);
  assert.equal(result.summary, '3 contributors · 289 commits', `${theme}: summary`);
  assert.notEqual(result.avatarBg, 'rgba(0, 0, 0, 0)', `${theme}: avatar has a palette colour`);
  assert.equal(result.loading, false);
  assert.equal(result.error, null);
  // Ann has 13 non-zero weeks, Bao 8, claude 1.
  assert.equal(result.bars, 22, `${theme}: one rect per non-zero week`);
  assert.equal(
    result.barFill,
    theme === 'vscode-dark' ? 'rgb(76, 141, 255)' : 'rgb(9, 105, 218)',
    `${theme}: bar colour follows the theme`
  );
  assert.match(result.tooltip || '', /^Week of .+ · \d[\d,]* commits?$/, `${theme}: hovering a bar shows the week and value`);

  const loading = renderTheme(theme, { ...state, contributors: [], firstWeek: undefined, loading: true }, 'loading');
  assert.equal(loading.loading, true, `${theme}: progress bar while loading`);
  assert.equal(loading.empty, 'Computing contributors…');

  const failed = renderTheme(theme, { ...state, contributors: [], firstWeek: undefined, error: 'fatal: bad revision' }, 'error');
  assert.equal(failed.error, 'fatal: bad revision', `${theme}: git error is shown`);
  assert.equal(failed.empty, 'No commits yet.');
  console.log(`${theme}: ok (${result.summary})`);
}
