'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('production image uses pinned Alpine Node 24 and the Dokku storage UID', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');

  assert.match(dockerfile, /^FROM node:24\.18\.0-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS dependencies$/m);
  assert.match(dockerfile, /^FROM node:24\.18\.0-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd$/m);
  assert.match(dockerfile, /^RUN npm ci --omit=dev --ignore-scripts/m);
  assert.match(dockerfile, /^EXPOSE 5000$/m);
  assert.match(dockerfile, /^USER 32767:32767$/m);
  assert.match(dockerfile, /^CMD \["node", "--experimental-sqlite", "index\.js"\]$/m);
  assert.match(dockerfile, /rm -rf \/usr\/local\/lib\/node_modules\/npm/);
  assert.match(dockerfile, /\/usr\/local\/lib\/node_modules\/corepack/);
  assert.match(dockerfile, /\/opt\/yarn-v\*/);
  for (const command of ['npm', 'npx', 'corepack', 'yarn', 'yarnpkg', 'pnpm', 'pnpx']) {
    assert.match(dockerfile, new RegExp(`/usr/local/bin/${command}(?:\\s|$)`));
  }
  assert.doesNotMatch(dockerfile, /(?:apk add|apt-get install)/);
  assert.doesNotMatch(dockerfile, /COPY .*preview\.js/);
  assert.doesNotMatch(dockerfile, /COPY .*mock-apps\.js/);
  assert.doesNotMatch(dockerfile, /^VOLUME /m);
});

test('Docker context excludes local and development-only files', () => {
  const ignored = new Set(fs.readFileSync(path.join(root, '.dockerignore'), 'utf8')
    .split(/\r?\n/).filter(Boolean));

  for (const entry of ['.git', 'node_modules', 'test', 'docs', '.env*', 'metrics.sqlite*', 'preview.js']) {
    assert.ok(ignored.has(entry), `${entry} must be excluded from the Docker context`);
  }
});

test('Dokku Procfile uses the same direct Node command as the image', () => {
  const procfile = fs.readFileSync(path.join(root, 'Procfile'), 'utf8').trim();

  assert.equal(procfile, 'web: node --experimental-sqlite index.js');
  assert.doesNotMatch(procfile, /\bnpm\b/);
});
