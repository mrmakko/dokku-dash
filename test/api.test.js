'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createDashboard } = require('../index');

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
      'com.dokku.app-name': 'alpha', 'openresty.domains': 'alpha.example.com',
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

test('production requires a session secret and configures secure cookies behind trusted proxy', () => {
  assert.throws(() => createDashboard({ env: { NODE_ENV: 'production' } }), /SESSION_SECRET/);
  const dashboard = createDashboard({ env: { NODE_ENV: 'production', SESSION_SECRET: 'secret' }, store: { close() {} }, collector: { start() {}, stop() {} } });
  assert.equal(dashboard.app.get('trust proxy'), 1);
});

test('shutdown stops collection and closes SQLite lifecycle dependencies', () => {
  let stopped = 0; let closed = 0;
  const dashboard = createDashboard({ env: { SESSION_SECRET: 'secret' }, store: { close: () => closed++ }, collector: { start() {}, stop: () => stopped++ } });
  dashboard.close();
  assert.equal(stopped, 1);
  assert.equal(closed, 1);
});
