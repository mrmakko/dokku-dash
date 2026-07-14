'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createDashboard } = require('../index');
const { MetricsStore } = require('../lib/metrics-store');
const { MetricsCollector } = require('../lib/metrics-collector');

function request(server, options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port: server.address().port, ...options }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.end(body); else req.end();
  });
}

test('authenticated apps API preserves fields and serializes missing metrics as null', async t => {
  const metrics = { current: null, peaks7d: { cpuPercent: null, memoryBytes: null }, history24h: [], containers: [] };
  const dashboard = createDashboard({
    env: { DASHBOARD_PASSWORD: 'pw', SESSION_SECRET: 'test-secret' },
    listContainers: async () => [{ Id: 'one', State: 'running', Status: 'Up', Labels: {
      'com.dokku.app-name': 'alpha', 'openresty.domains': 'alpha.example.com', 'openresty.ssl': 'true',
    } }],
    getStats: async () => ({ memory_stats: { usage: 1048576 } }),
    getLastCommit: () => null,
    store: { getAppMetrics: () => metrics, recordRun() {}, close() {} },
    collector: { start() {}, stop() {} },
  });
  const server = dashboard.app.listen(0);
  t.after(() => server.close());
  const login = await request(server, { method: 'POST', path: '/login', headers: { 'content-type': 'application/x-www-form-urlencoded' } }, 'password=pw');
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const response = await request(server, { path: '/api/apps', headers: { cookie } });
  assert.equal(response.status, 200);
  const [app] = JSON.parse(response.body);
  assert.deepEqual(Object.keys(app), ['name', 'status', 'uptime', 'memoryMB', 'lastCommit', 'url', 'metrics']);
  assert.equal(app.url, 'https://alpha.example.com');
  assert.deepEqual(app.metrics, metrics);
});

test('debug endpoint is absent unless explicitly enabled', async t => {
  const dashboard = createDashboard({ env: { SESSION_SECRET: 'test-secret' }, store: { close() {} }, collector: { start() {}, stop() {} } });
  const server = dashboard.app.listen(0);
  t.after(() => server.close());
  const response = await request(server, { path: '/api/debug' });
  assert.equal(response.status, 404);
});

test('enabled debug endpoint still requires authentication', async t => {
  const dashboard = createDashboard({ env: { SESSION_SECRET: 'test', ENABLE_DEBUG_ENDPOINT: 'true' }, store: { close() {} }, collector: { start() {}, stop() {} } });
  const server = dashboard.app.listen(0); t.after(() => server.close());
  const response = await request(server, { path: '/api/debug' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, '/login');
});

test('production requires a session secret and configures secure cookies behind trusted proxy', () => {
  assert.throws(() => createDashboard({ env: { NODE_ENV: 'production' } }), /SESSION_SECRET/);
  assert.throws(() => createDashboard({ env: { NODE_ENV: 'production', SESSION_SECRET: 'secret' } }), /METRICS_DB_PATH/);
  const dashboard = createDashboard({ env: { NODE_ENV: 'production', SESSION_SECRET: 'secret', METRICS_DB_PATH: 'unused' }, store: { close() {} }, collector: { start() {}, stop() {} } });
  assert.equal(dashboard.app.get('trust proxy'), 1);
});

test('production login emits a secure cookie through the trusted HTTPS proxy', async t => {
  const dashboard = createDashboard({ env: { NODE_ENV: 'production', SESSION_SECRET: 'secret', METRICS_DB_PATH: 'unused', DASHBOARD_PASSWORD: 'pw' }, store: { close() {} }, collector: { start() {}, stop() {} } });
  const server = dashboard.app.listen(0); t.after(() => server.close());
  const response = await request(server, { method: 'POST', path: '/login', headers: {
    'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-proto': 'https',
  } }, 'password=pw');
  assert.match(response.headers['set-cookie'][0], /; Secure;/);
});

test('uses HTTP without a TLS label and HTTPS when TLS is enabled', async () => {
  const make = labels => createDashboard({
    env: { SESSION_SECRET: 'test' }, listContainers: async () => [{ Id: 'one', State: 'exited', Labels: { 'com.dokku.app-name': 'alpha', 'openresty.domains': 'alpha.test', ...labels } }],
    store: { getAppMetrics: () => ({ current: null, peaks7d: {}, history24h: [], containers: [] }), close() {} }, collector: { start() {}, stop() {} }, getLastCommit: () => null,
  });
  const plain = make({}); const secure = make({ 'openresty.ssl': 'true' });
  assert.equal((await plain.getApps())[0].url, 'http://alpha.test');
  assert.equal((await secure.getApps())[0].url, 'https://alpha.test');
});

test('container metrics mirror current Docker discovery and exclude stale stored containers', async () => {
  const dashboard = createDashboard({
    env: { SESSION_SECRET: 'test' }, listContainers: async () => [{ Id: 'new', State: 'running', Status: 'Up', Labels: { 'com.dokku.app-name': 'alpha', 'com.dokku.process-type': 'web' } }],
    getStats: async () => ({ memory_stats: { usage: 1 } }), getLastCommit: () => null,
    store: { getAppMetrics: () => ({ current: null, peaks7d: {}, history24h: [], containers: [{ containerId: 'stale', cpuPercent: 9 }] }), close() {} }, collector: { start() {}, stop() {} },
  });
  const containers = (await dashboard.getApps())[0].metrics.containers;
  assert.deepEqual(containers, [{ containerId: 'new', processName: 'web', state: 'running', timestamp: null, cpuPercent: null, memoryBytes: null, memoryLimitBytes: null }]);
});

test('collector samples flow through SQLite into the authenticated apps API', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-integration-'));
  const store = new MetricsStore(path.join(directory, 'metrics.sqlite'));
  const containers = [{ Id: 'one', State: 'running', Status: 'Up', Labels: { 'com.dokku.app-name': 'alpha', 'com.dokku.process-type': 'web' } }];
  const dockerStats = { cpu_stats: { cpu_usage: { total_usage: 10 }, system_cpu_usage: 100, online_cpus: 1 }, precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 }, memory_stats: { usage: 50, limit: 100, stats: {} } };
  const collector = new MetricsCollector({ listContainers: async () => containers, getStats: async () => dockerStats, store, now: () => 1000 });
  await collector.collect();
  const dashboard = createDashboard({ env: { SESSION_SECRET: 'test', DASHBOARD_PASSWORD: 'pw' }, listContainers: async () => containers, getStats: async () => dockerStats, getLastCommit: () => null, store, collector: { start() {}, stop() {} }, now: () => 1000 });
  const server = dashboard.app.listen(0);
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await dashboard.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const login = await request(server, { method: 'POST', path: '/login', headers: { 'content-type': 'application/x-www-form-urlencoded' } }, 'password=pw');
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const response = await request(server, { path: '/api/apps', headers: { cookie } });
  const metrics = JSON.parse(response.body)[0].metrics;
  assert.equal(metrics.current.cpuPercent, 10);
  assert.equal(metrics.containers[0].containerId, 'one');
  assert.equal(metrics.containers[0].state, 'running');
});

test('docker client rejects non-success responses with status and response message', async t => {
  const { dockerGet } = require('../index');
  const fake = http.createServer((_req, res) => { res.writeHead(500); res.end(JSON.stringify({ message: 'daemon failed' })); });
  await new Promise(resolve => fake.listen(0, resolve));
  t.after(() => fake.close());
  await assert.rejects(() => dockerGet('/containers/json', { port: fake.address().port }), /500.*daemon failed/);
});

test('shutdown waits for collection stop before closing SQLite lifecycle dependencies', async () => {
  const order = [];
  let release;
  const dashboard = createDashboard({ env: { SESSION_SECRET: 'secret' }, store: { close: () => order.push('close') }, collector: { start() {}, stop: () => new Promise(resolve => { release = () => { order.push('stop'); resolve(); }; }) } });
  const closing = dashboard.close();
  assert.deepEqual(order, []);
  release();
  await closing;
  assert.deepEqual(order, ['stop', 'close']);
});
