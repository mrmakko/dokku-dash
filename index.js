'use strict';

const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { MetricsStore } = require('./lib/metrics-store');
const { MetricsCollector } = require('./lib/metrics-collector');

const DOKKU_ROOT = '/home/dokku';
const DOCKER_SOCKET = '/var/run/docker.sock';

function dockerGet(apiPath, connection = { socketPath: DOCKER_SOCKET }, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const request = http.request({ ...connection, path: apiPath, method: 'GET' }, response => {
      let data = '';
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch (_error) {
          reject(new Error(`Docker returned ${response.statusCode}: invalid JSON: ${data.slice(0, 200)}`)); return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Docker returned ${response.statusCode}: ${parsed.message || response.statusMessage || 'request failed'}`)); return;
        }
        resolve(parsed);
      });
    });
    request.on('error', reject);
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Docker request timed out after ${timeoutMs}ms: ${apiPath}`));
    });
    request.end();
  });
}

function defaultGetLastCommit(appName) {
  try {
    const output = execFileSync('git', ['-C', path.join(DOKKU_ROOT, appName), 'log', '-1', '--format=%h|||%s|||%ar'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const [hash, message, when] = output.split('|||');
    return { hash, message, when };
  } catch (_error) { return null; }
}

function deployFilters() {
  return encodeURIComponent(JSON.stringify({ label: ['com.dokku.container-type=deploy'] }));
}

function createDashboard(options = {}) {
  const env = options.env || process.env;
  if (env.NODE_ENV === 'production' && !env.SESSION_SECRET) throw new Error('SESSION_SECRET is required in production');
  if (env.NODE_ENV === 'production' && !env.METRICS_DB_PATH) throw new Error('METRICS_DB_PATH is required in production');
  const configuredTimeout = Number(options.dockerRequestTimeoutMs ?? env.DOCKER_REQUEST_TIMEOUT_MS);
  const dockerRequestTimeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 10000;
  const listContainers = options.listContainers || (() => dockerGet(`/containers/json?all=1&size=1&filters=${deployFilters()}`, { socketPath: DOCKER_SOCKET }, dockerRequestTimeoutMs));
  const getStorageUsage = options.getStorageUsage || (() => dockerGet('/system/df?type=volume', { socketPath: DOCKER_SOCKET }, dockerRequestTimeoutMs));
  const getStats = options.getStats || (id => dockerGet(`/containers/${id}/stats?stream=false`, { socketPath: DOCKER_SOCKET }, dockerRequestTimeoutMs));
  const getLastCommit = options.getLastCommit || defaultGetLastCommit;
  const store = options.store || new MetricsStore(env.METRICS_DB_PATH || path.join(__dirname, 'metrics.sqlite'));
  const collector = options.collector || new MetricsCollector({ listContainers, getStats, store });
  const app = express();
  if (env.NODE_ENV === 'production') app.set('trust proxy', 1);
  app.use(bodyParser.json());
  app.use(bodyParser.urlencoded({ extended: true }));
  app.use(session({
    secret: env.SESSION_SECRET || 'development-only-session-secret',
    resave: false, saveUninitialized: true,
    cookie: { secure: env.NODE_ENV === 'production', httpOnly: true, sameSite: 'lax' },
  }));
  app.use(express.static(path.join(__dirname, 'public')));

  function isAuthenticated(req, res, next) {
    if (req.session.authenticated) next(); else res.redirect('/login');
  }

  async function getApps() {
    const [containers, diskUsage] = await Promise.all([
      listContainers(),
      getStorageUsage().catch(() => null),
    ]);
    const cacheBytesByApp = new Map(((diskUsage && diskUsage.Volumes) || [])
      .filter(volume => typeof volume.Name === 'string' && volume.Name.startsWith('cache-'))
      .map(volume => [volume.Name.slice('cache-'.length), volume.UsageData && Number.isFinite(volume.UsageData.Size) && volume.UsageData.Size >= 0 ? volume.UsageData.Size : null]));
    const appsMap = new Map();
    const containersByApp = new Map();
    for (const container of containers) {
      const name = container.Labels && container.Labels['com.dokku.app-name'];
      if (!name) continue;
      if (!containersByApp.has(name)) containersByApp.set(name, []);
      containersByApp.get(name).push(container);
      let appData = appsMap.get(name);
      if (!appData || (appData.state !== 'running' && container.State === 'running')) {
        const domains = container.Labels['openresty.domains'];
        const domainList = domains ? domains.split(' ').filter(Boolean) : [];
        const chosen = domainList.find(domain => !domain.includes('.4289301-')) || domainList[0];
        const enabledValues = ['true', 'yes', 'enabled', '1'];
        const tls = enabledValues.includes(String(container.Labels['openresty.ssl'] || '').toLowerCase())
          || enabledValues.includes(String(container.Labels['com.dokku.letsencrypt.enabled'] || '').toLowerCase());
        appData = { id: container.Id, state: container.State, uptime: container.Status, url: chosen ? `${tls ? 'https' : 'http'}://${chosen}` : '' };
        appsMap.set(name, appData);
      }
    }
    const now = options.now ? options.now() : Date.now();
    const apps = await Promise.all([...appsMap.entries()].map(async ([name, data]) => {
      let memoryMB = null;
      if (data.state === 'running') {
        try { const stats = await getStats(data.id); memoryMB = (stats.memory_stats.usage / 1024 / 1024).toFixed(0); } catch (_error) {}
      }
      const metrics = store.getAppMetrics(name, now);
      const storedContainers = new Map(metrics.containers.map(container => [container.containerId, container]));
      metrics.containers = containersByApp.get(name).map(container => {
        const stored = storedContainers.get(container.Id) || {};
        return {
          containerId: container.Id,
          processName: (container.Labels && container.Labels['com.dokku.process-type']) || stored.processName || null,
          state: container.State || null,
          timestamp: stored.timestamp ?? null,
          cpuPercent: stored.cpuPercent ?? null,
          memoryBytes: stored.memoryBytes ?? null,
          memoryLimitBytes: stored.memoryLimitBytes ?? null,
          diskWritableBytes: Number.isFinite(container.SizeRw) && container.SizeRw >= 0 ? container.SizeRw : null,
          diskRootFsBytes: Number.isFinite(container.SizeRootFs) && container.SizeRootFs >= 0 ? container.SizeRootFs : null,
        };
      });
      const writableSizes = metrics.containers.map(container => container.diskWritableBytes).filter(Number.isFinite);
      return {
        name, status: data.state === 'running' ? 'running' : 'stopped',
        uptime: data.state === 'running' ? data.uptime : null, memoryMB,
        lastCommit: getLastCommit(name), url: data.url,
        storage: {
          containerWritableBytes: writableSizes.length ? writableSizes.reduce((total, size) => total + size, 0) : null,
          cacheBytes: cacheBytesByApp.get(name) ?? null,
        },
        metrics,
      };
    }));
    return apps.sort((left, right) => left.name.localeCompare(right.name));
  }

  app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
  app.post('/login', (req, res) => {
    if (req.body.password === (env.DASHBOARD_PASSWORD || 'changeme')) {
      req.session.authenticated = true; res.redirect('/');
    } else res.status(401).send('Invalid password. <a href="/login">Try again</a>');
  });
  app.get('/', isAuthenticated, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
  app.get('/api/apps', isAuthenticated, async (_req, res) => {
    try { res.json(await getApps()); } catch (error) { console.error('Error getting apps:', error); res.status(500).json({ error: error.message }); }
  });
  if (env.ENABLE_DEBUG_ENDPOINT === 'true') {
    app.get('/api/debug', isAuthenticated, async (_req, res) => res.json({
      dokkuRootExists: fs.existsSync(DOKKU_ROOT), dockerSocketExists: fs.existsSync(DOCKER_SOCKET),
    }));
  }
  app.post('/logout', isAuthenticated, (req, res) => { req.session.authenticated = false; res.redirect('/login'); });

  collector.start();
  let closed = false;
  return { app, collector, store, getApps, async close() {
    if (closed) return;
    closed = true;
    try { await collector.stop(); } finally { store.close(); }
  } };
}

async function shutdownDashboard(server, dashboard) {
  try { await dashboard.close(); } finally { server.close(); }
}

function startServer(options = {}) {
  const dashboard = createDashboard(options);
  const port = (options.env || process.env).PORT || 5000;
  const server = dashboard.app.listen(port, () => console.log(`Dashboard running on port ${port}`));
  const shutdown = () => shutdownDashboard(server, dashboard).catch(error => {
    console.error(`Dashboard shutdown failed: ${error.message}`);
    process.exitCode = 1;
  });
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return { ...dashboard, server };
}

if (require.main === module) startServer();

module.exports = { createDashboard, startServer, shutdownDashboard, dockerGet };
