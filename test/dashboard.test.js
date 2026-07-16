'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  escapeHtml,
  formatCpu,
  formatBytes,
  renderSparkline,
  renderUsageDistribution,
  renderAppCard,
  renderApps,
  loadApps,
} = require('../public/dashboard');

test('formats CPU, memory, and unavailable values for cards', () => {
  assert.equal(formatCpu(12.345), '12.3%');
  assert.equal(formatCpu(150), '150.0%');
  assert.equal(formatCpu(null), 'Unavailable');
  assert.equal(formatBytes(1572864), '1.5 MB');
  assert.equal(formatBytes(null), 'Unavailable');
});

test('sparkline creates separate SVG paths around null and missing samples', () => {
  const history = [
    { timestamp: 0, cpuPercent: 10 },
    { timestamp: 600000, cpuPercent: 20 },
    { timestamp: 1200000, cpuPercent: null },
    { timestamp: 1800000, cpuPercent: 30 },
    { timestamp: 3600000, cpuPercent: 40 },
  ];
  const svg = renderSparkline(history, 'cpuPercent', 'CPU usage over 24 hours', 24 * 60 * 60 * 1000);
  assert.match(svg, /<svg[^>]+role="img"[^>]+aria-label="CPU usage over 24 hours, vertical scale 0 to 40%"/);
  assert.equal((svg.match(/<path /g) || []).length, 3);
  assert.match(svg, /vertical scale 0 to 40%/);
  assert.match(svg, />20%<\/text>/);
  assert.doesNotMatch(svg, /NaN|undefined/);
});

test('RAM sparkline labels its vertical axis using readable byte units', () => {
  const now = Date.UTC(2026, 6, 14, 12);
  const svg = renderSparkline([
    { timestamp: now - 600000, memoryBytes: 1024 * 1024 * 512 },
  ], 'memoryBytes', 'RAM usage over 24 hours', now);
  assert.match(svg, /vertical scale 0 to 512 MB/);
  assert.match(svg, />256 MB<\/text>/);
  assert.match(svg, />0 B<\/text>/);
});

test('sparkline axis labels use whole numbers without changing card metric precision', () => {
  const now = Date.UTC(2026, 6, 14, 12);
  const cpuSvg = renderSparkline([{ timestamp: now - 600000, cpuPercent: 12.6 }], 'cpuPercent', 'CPU', now);
  const ramSvg = renderSparkline([{ timestamp: now - 600000, memoryBytes: 1.5 * 1024 * 1024 * 1024 }], 'memoryBytes', 'RAM', now);
  assert.match(cpuSvg, /vertical scale 0 to 13%/);
  assert.match(ramSvg, /vertical scale 0 to 2 GB/);
  assert.doesNotMatch(`${cpuSvg}${ramSvg}`, />[^<]*\d+\.\d+[^<]*<\/text>/);
  assert.equal(formatCpu(12.6), '12.6%');
  assert.equal(formatBytes(1.5 * 1024 * 1024 * 1024), '1.5 GB');
});

test('sparkline uses a fixed 24-hour axis ending at the injected current time', () => {
  const now = Date.UTC(2026, 6, 14, 12);
  const svg = renderSparkline([
    { timestamp: now - 20 * 60 * 1000, cpuPercent: 10 },
    { timestamp: now - 10 * 60 * 1000, cpuPercent: 20 },
  ], 'cpuPercent', 'CPU usage over 24 hours', now);
  const path = svg.match(/<path d="([^"]+)"/)[1];
  assert.match(path, /^M 312\.5 /);
  assert.match(path, /L 314\.2 /);
});

test('app card escapes application, status, URL, deploy, and container data', () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const html = renderAppCard({
    name: hostile, status: hostile, url: `https://example.test/?q=${hostile}`,
    lastCommit: { hash: hostile, message: hostile, when: hostile },
    metrics: { current: null, peaks7d: {}, history24h: [], containers: [{ containerId: hostile, processName: hostile, state: hostile }] },
  });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.equal(escapeHtml("<&\"'"), '&lt;&amp;&quot;&#039;');
});

test('app card renders current and weekly aggregate metrics as plain numbers', () => {
  const html = renderAppCard({ name: 'alpha', status: 'running', storage: { containerRootFsBytes: 314572800, cacheBytes: 1073741824 }, metrics: {
    current: { cpuPercent: 25.25, memoryBytes: 104857600, memoryLimitBytes: 536870912 },
    peaks7d: { cpuPercent: 88.8, memoryBytes: 209715200 }, history24h: [], containers: [],
  } });
  assert.match(html, /Current CPU[\s\S]*25\.3%/);
  assert.match(html, /Current RAM used[\s\S]*class="metric-value metric-value-inline">100\.0 MB \/ 512\.0 MB<\/strong>/);
  assert.doesNotMatch(html, /Limit: 512\.0 MB/);
  assert.match(html, /7-day CPU peak[\s\S]*88\.8%/);
  assert.match(html, /7-day RAM peak[\s\S]*200\.0 MB/);
  assert.match(html, /Root filesystem[\s\S]*300\.0 MB/);
  assert.match(html, /Build cache[\s\S]*1\.0 GB/);
  assert.doesNotMatch(html, /Container writable disk/);
  assert.equal((html.match(/<svg/g) || []).length, 2);
});

test('usage distribution renders proportional accessible RAM and root filesystem segments', () => {
  const apps = [
    { name: 'alpha', metrics: { current: { memoryBytes: 100 } }, storage: { containerRootFsBytes: 300 } },
    { name: 'beta', metrics: { current: { memoryBytes: 300 } }, storage: { containerRootFsBytes: 100 } },
  ];
  const html = renderUsageDistribution(apps);
  assert.match(html, /Current RAM[\s\S]*Total 400 B[\s\S]*alpha: 100 B \(25\.0% of total\)[\s\S]*beta: 300 B \(75\.0% of total\)/);
  assert.match(html, /Root filesystem[\s\S]*Total 400 B[\s\S]*alpha: 300 B \(75\.0% of total\)[\s\S]*beta: 100 B \(25\.0% of total\)/);
  assert.equal((html.match(/role="img" tabindex="0"/g) || []).length, 4);
  assert.match(html, /--segment-width:25\.000000%/);
  const colors = [...html.matchAll(/--segment-color:(hsl\([^)]+\))/g)].map(match => match[1]);
  assert.deepEqual(colors, [colors[0], colors[1], colors[0], colors[1]]);
  assert.notEqual(colors[0], colors[1]);
  assert.doesNotMatch(html, /cacheBytes|diskWritableBytes/);
});

test('usage distribution handles unavailable and zero totals without invalid segments', () => {
  const html = renderUsageDistribution([
    { name: 'zero', metrics: { current: { memoryBytes: 0 } }, storage: {} },
    { name: 'missing', metrics: {}, storage: {} },
  ]);
  assert.match(html, /Current RAM[\s\S]*Total 0 B[\s\S]*No usage/);
  assert.match(html, /Root filesystem[\s\S]*Total Unavailable[\s\S]*No data/);
  assert.doesNotMatch(html, /usage-segment|NaN|Infinity/);
});

test('rendered app list places usage distribution before project cards', () => {
  const html = renderApps([{ name: 'alpha', status: 'running', metrics: {}, storage: {} }]);
  assert.ok(html.indexOf('usage-distribution') < html.indexOf('apps-grid'));
});

test('app card links its name and keeps uptime in the heading without a raw URL footer', () => {
  const html = renderAppCard({ name: 'alpha', status: 'running', uptime: 'Up 41 hours', url: 'https://alpha.example', metrics: {} });
  assert.match(html, /class="app-identity"[\s\S]*class="app-name"><a href="https:\/\/alpha\.example"[^>]+>alpha<\/a><\/div><span class="app-uptime">[\s\S]*Up 41 hours<\/span>/);
  assert.doesNotMatch(html, /class="app-url"/);
  assert.equal((html.match(/https:\/\/alpha\.example/g) || []).length, 1);
});

test('app card renders a plain project name when no safe URL is available', () => {
  const html = renderAppCard({ name: 'alpha', status: 'running', url: 'javascript:alert(1)', metrics: {} });
  assert.match(html, /class="app-name">alpha<\/div>/);
  assert.doesNotMatch(html, /<a href=/);
});

test('app card includes accessible expandable current container details', () => {
  const html = renderAppCard({ name: 'alpha', status: 'running', metrics: {
    current: null, peaks7d: {}, history24h: [], containers: [
      { containerId: 'abcdef123456789', processName: 'web', state: 'running', cpuPercent: 3, memoryBytes: 1048576, memoryLimitBytes: 2097152, diskRootFsBytes: 104857600 },
      { containerId: 'worker-id', processName: 'worker', state: 'exited', cpuPercent: null, memoryBytes: null, memoryLimitBytes: null },
    ],
  } });
  assert.match(html, /<details class="container-details">/);
  assert.match(html, /<summary>Containers \(2\)<\/summary>/);
  assert.match(html, /<table>[\s\S]*<caption class="sr-only">Current container metrics for alpha<\/caption>/);
  assert.match(html, /<th scope="col">Process<\/th>/);
  assert.match(html, /<th scope="col">Root filesystem<\/th>/);
  assert.doesNotMatch(html, /Writable disk/);
  assert.match(html, /web[\s\S]*running[\s\S]*3\.0%[\s\S]*1\.0 MB \/ 2\.0 MB[\s\S]*100\.0 MB/);
  assert.match(html, /worker[\s\S]*exited[\s\S]*Unavailable/);
});

test('dashboard header owns refresh controls and an accessible live status', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/dashboard.html'), 'utf8');
  assert.match(html, /class="header-controls"/);
  assert.match(html, /id="refresh-status"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(html, /id="refresh-button"[^>]+onclick="loadApps\(\)"[^>]*>(?:<span[^>]*>[^<]*<\/span>\s*)?Refresh<\/button>/);
  assert.doesNotMatch(html, /class="toolbar"/);
  assert.doesNotMatch(html, /<h1>Project fleet<\/h1>/i);
});

test('dashboard cards use larger chart labels without decorative lines below charts', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
  assert.match(css, /\.sparkline-tick text\s*{[^}]*font-size:\s*14px/);
  assert.doesNotMatch(css, /\.sparkline[^{}]*{[^}]*border-bottom/);
  assert.doesNotMatch(css, /\.container-details\s*{[^}]*border-top/);
});

test('refresh keeps rendered cards visible, prevents overlap, and reports failures in the header', async () => {
  const container = { innerHTML: '<div class="loading">Loading projects...</div>' };
  const status = { textContent: '', className: '', hidden: true };
  const button = { disabled: false };
  global.document = { getElementById(id) {
    return { 'apps-container': container, 'refresh-status': status, 'refresh-button': button }[id];
  } };
  let rejectFetch;
  let fetchCalls = 0;
  const originalConsoleError = console.error;
  console.error = () => {};
  global.fetch = () => {
    fetchCalls++;
    if (fetchCalls === 1) return Promise.resolve({ ok: true, json: async () => [{ name: 'existing', status: 'running' }] });
    return new Promise((resolve, reject) => { rejectFetch = reject; });
  };

  await loadApps();
  const first = loadApps();
  const overlapping = loadApps();
  assert.equal(fetchCalls, 2);
  assert.match(container.innerHTML, /existing/);
  assert.equal(button.disabled, true);
  assert.equal(status.hidden, false);
  assert.equal(status.textContent, 'Refreshing…');

  rejectFetch(new Error('offline'));
  await Promise.all([first, overlapping]);
  assert.match(container.innerHTML, /existing/);
  assert.equal(button.disabled, false);
  assert.equal(status.hidden, false);
  assert.equal(status.textContent, 'Refresh failed');
  console.error = originalConsoleError;
  delete global.document;
  delete global.fetch;
});

test('refresh preserves a successfully rendered empty state', async () => {
  const container = { innerHTML: '<div class="loading">Loading projects...</div>' };
  const status = { textContent: '', className: '', hidden: true };
  const button = { disabled: false };
  global.document = { getElementById(id) {
    return { 'apps-container': container, 'refresh-status': status, 'refresh-button': button }[id];
  } };
  let resolveRefresh;
  let fetchCalls = 0;
  global.fetch = () => {
    fetchCalls++;
    if (fetchCalls === 1) return Promise.resolve({ ok: true, json: async () => [] });
    return new Promise(resolve => { resolveRefresh = resolve; });
  };

  await loadApps();
  assert.match(container.innerHTML, /No projects deployed yet/);
  const refresh = loadApps();
  assert.match(container.innerHTML, /No projects deployed yet/);
  assert.doesNotMatch(container.innerHTML, /Loading projects/);
  resolveRefresh({ ok: true, json: async () => [] });
  await refresh;
  delete global.document;
  delete global.fetch;
});

test('header controls wrap without overflowing narrow screens', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*?\.header-content\s*{[^}]*flex-wrap:\s*wrap/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*?\.header-controls\s*{[^}]*flex-wrap:\s*wrap/);
});
