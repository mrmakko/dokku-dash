const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { MetricsStore } = require('../lib/metrics-store');

function withStore(fn) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-store-'));
  const store = new MetricsStore(path.join(directory, 'metrics.sqlite'));
  try { return fn(store); } finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}

function appSample(cpuPercent, memoryBytes) {
  return { scope: 'app', appName: 'alpha', containerId: null, processName: null,
    cpuPercent, memoryBytes, memoryLimitBytes: 2048 };
}

test('records a run transactionally and returns app and container history', () => withStore((store) => {
  const timestamp = Date.UTC(2026, 6, 14, 12);
  store.recordRun(timestamp, [
    appSample(12.5, 1000),
    { scope: 'container', appName: 'alpha', containerId: 'c1', processName: 'web',
      cpuPercent: 7.5, memoryBytes: 600, memoryLimitBytes: 1024 },
  ]);
  const result = store.getAppMetrics('alpha', timestamp);
  assert.deepEqual(result.current, { timestamp, cpuPercent: 12.5, memoryBytes: 1000, memoryLimitBytes: 2048 });
  assert.deepEqual(result.history24h, [{ timestamp, cpuPercent: 12.5, memoryBytes: 1000, memoryLimitBytes: 2048 }]);
  assert.deepEqual(result.containers, [{ containerId: 'c1', processName: 'web', timestamp,
    cpuPercent: 7.5, memoryBytes: 600, memoryLimitBytes: 1024 }]);
}));

test('rolls back every sample when one sample is invalid', () => withStore((store) => {
  const timestamp = Date.UTC(2026, 6, 14, 12);
  assert.throws(() => store.recordRun(timestamp, [appSample(10, 10), { ...appSample(20, 20), appName: null }]));
  assert.equal(store.getAppMetrics('alpha', timestamp).current, null);
}));

test('retains detailed samples for only 24 hours', () => withStore((store) => {
  const now = Date.UTC(2026, 6, 14, 12);
  store.recordRun(now - 24 * 60 * 60 * 1000 - 1, [appSample(90, 900)]);
  store.recordRun(now, [appSample(10, 100)]);
  assert.deepEqual(store.getAppMetrics('alpha', now).history24h.map((row) => row.timestamp), [now]);
}));

test('keeps hourly maxima and exposes one rolling seven-day peak', () => withStore((store) => {
  const now = Date.UTC(2026, 6, 14, 12, 30);
  store.recordRun(now - 2 * 60 * 60 * 1000, [appSample(10, 100)]);
  store.recordRun(now - 110 * 60 * 1000, [appSample(80, 500)]);
  store.recordRun(now - 100 * 60 * 1000, [appSample(20, 900)]);
  assert.deepEqual(store.getAppMetrics('alpha', now).peaks7d, { cpuPercent: 80, memoryBytes: 900 });
}));

test('excludes hourly peaks outside the rolling seven-day window', () => withStore((store) => {
  const now = Date.UTC(2026, 6, 14, 12, 30);
  store.recordRun(now - 8 * 24 * 60 * 60 * 1000, [appSample(99, 999)]);
  store.recordRun(now, [appSample(4, 40)]);
  assert.deepEqual(store.getAppMetrics('alpha', now).peaks7d, { cpuPercent: 4, memoryBytes: 40 });
}));

test('returns null metrics and empty history when no samples exist', () => withStore((store) => {
  assert.deepEqual(store.getAppMetrics('missing', Date.now()), {
    current: null,
    peaks7d: { cpuPercent: null, memoryBytes: null },
    history24h: [],
    containers: [],
  });
}));
