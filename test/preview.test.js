'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createPreviewApp } = require('../preview');
const { buildMockApps } = require('../lib/mock-apps');

function request(server, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get({ port: server.address().port, path: pathname }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body, headers: response.headers }));
    });
    request.on('error', reject);
  });
}

test('mock apps are deterministic and cover preview states and storage metrics', () => {
  const now = Date.UTC(2026, 6, 16, 12);
  const first = buildMockApps(now);
  assert.deepEqual(first, buildMockApps(now));
  assert.ok(first.some(app => app.status === 'running'));
  assert.ok(first.some(app => app.status === 'stopped'));
  assert.ok(first.every(app => Number.isFinite(app.storage.containerRootFsBytes)));
  assert.ok(first.every(app => Number.isFinite(app.storage.cacheBytes)));
  assert.ok(first.some(app => app.metrics.history24h.length > 100));
  assert.ok(first.some(app => app.url && app.uptime));
});

test('preview serves the dashboard and unauthenticated mock API', async t => {
  const now = Date.UTC(2026, 6, 16, 12);
  const server = createPreviewApp({ now: () => now }).listen(0);
  t.after(() => server.close());

  const [page, api] = await Promise.all([request(server, '/'), request(server, '/api/apps')]);
  assert.equal(page.status, 200);
  assert.match(page.body, /Dokku Dashboard/);
  assert.equal(api.status, 200);
  assert.match(api.headers['content-type'], /^application\/json/);
  assert.deepEqual(JSON.parse(api.body), buildMockApps(now));
});
