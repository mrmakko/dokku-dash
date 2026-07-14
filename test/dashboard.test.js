'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  escapeHtml,
  formatCpu,
  formatBytes,
  renderSparkline,
  renderAppCard,
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
  const svg = renderSparkline(history, 'cpuPercent', 'CPU usage over 24 hours');
  assert.match(svg, /<svg[^>]+role="img"[^>]+aria-label="CPU usage over 24 hours"/);
  assert.equal((svg.match(/<path /g) || []).length, 3);
  assert.doesNotMatch(svg, /NaN|undefined/);
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
  const html = renderAppCard({ name: 'alpha', status: 'running', metrics: {
    current: { cpuPercent: 25.25, memoryBytes: 104857600, memoryLimitBytes: 536870912 },
    peaks7d: { cpuPercent: 88.8, memoryBytes: 209715200 }, history24h: [], containers: [],
  } });
  assert.match(html, /Current CPU[\s\S]*25\.3%/);
  assert.match(html, /Current RAM[\s\S]*100\.0 MB \/ 512\.0 MB/);
  assert.match(html, /7-day CPU peak[\s\S]*88\.8%/);
  assert.match(html, /7-day RAM peak[\s\S]*200\.0 MB/);
  assert.equal((html.match(/<svg/g) || []).length, 2);
});

test('app card includes accessible expandable current container details', () => {
  const html = renderAppCard({ name: 'alpha', status: 'running', metrics: {
    current: null, peaks7d: {}, history24h: [], containers: [
      { containerId: 'abcdef123456789', processName: 'web', state: 'running', cpuPercent: 3, memoryBytes: 1048576, memoryLimitBytes: 2097152 },
      { containerId: 'worker-id', processName: 'worker', state: 'exited', cpuPercent: null, memoryBytes: null, memoryLimitBytes: null },
    ],
  } });
  assert.match(html, /<details class="container-details">/);
  assert.match(html, /<summary>Containers \(2\)<\/summary>/);
  assert.match(html, /<table>[\s\S]*<caption class="sr-only">Current container metrics for alpha<\/caption>/);
  assert.match(html, /<th scope="col">Process<\/th>/);
  assert.match(html, /web[\s\S]*running[\s\S]*3\.0%[\s\S]*1\.0 MB \/ 2\.0 MB/);
  assert.match(html, /worker[\s\S]*exited[\s\S]*Unavailable/);
});
