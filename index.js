const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 5000;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'changeme';
const DOKKU_ROOT = '/home/dokku';
const DOCKER_SOCKET = '/var/run/docker.sock';

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  secret: 'dokku-dashboard-secret',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false, httpOnly: true }
}));
app.use(express.static('public'));

function isAuthenticated(req, res, next) {
  if (req.session.authenticated) {
    next();
  } else {
    res.redirect('/login');
  }
}

// Query Docker socket HTTP API directly — no docker binary needed
function dockerGet(apiPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: DOCKER_SOCKET, path: apiPath, method: 'GET' },
      (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`JSON parse failed: ${data.slice(0, 200)}`)); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function getContainerMemoryMB(containerId) {
  try {
    const stats = await dockerGet(`/containers/${containerId}/stats?stream=false`);
    return (stats.memory_stats.usage / 1024 / 1024).toFixed(0);
  } catch (e) {
    return null;
  }
}

function getLastCommit(appName) {
  try {
    const out = execSync(
      `git -C ${path.join(DOKKU_ROOT, appName)} log -1 --format="%h|||%s|||%ar"`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    const [hash, message, when] = out.split('|||');
    return { hash, message, when };
  } catch (e) {
    return null;
  }
}

async function getApps() {
  const filters = encodeURIComponent(JSON.stringify({ label: ['com.dokku.container-type=deploy'] }));
  const containers = await dockerGet(`/containers/json?all=1&filters=${filters}`);

  // Deduplicate by app name — prefer 'running' state
  const appsMap = new Map();
  for (const c of containers) {
    const name = c.Labels && c.Labels['com.dokku.app-name'];
    if (!name) continue;
    if (!appsMap.has(name) || c.State === 'running') {
      let url = '';
      const domains = c.Labels['openresty.domains'];
      if (domains) {
        const domainList = domains.split(' ').filter(Boolean);
        const custom = domainList.find(d => !d.includes('.4289301-'));
        const chosen = custom || domainList[0];
        if (chosen) url = `http://${chosen}`;
      }
      appsMap.set(name, { id: c.Id, state: c.State, uptime: c.Status, url });
    }
  }

  // Fetch memory + last commit in parallel per app
  const apps = await Promise.all(
    [...appsMap.entries()].map(async ([name, { id, state, uptime, url }]) => {
      const [memoryMB, lastCommit] = await Promise.all([
        state === 'running' ? getContainerMemoryMB(id) : Promise.resolve(null),
        Promise.resolve(getLastCommit(name)),
      ]);
      return {
        name,
        status: state === 'running' ? 'running' : 'stopped',
        uptime: state === 'running' ? uptime : null,
        memoryMB,
        lastCommit,
        url,
      };
    })
  );

  return apps.sort((a, b) => a.name.localeCompare(b.name));
}

// Routes
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  const { password } = req.body;
  if (password === DASHBOARD_PASSWORD) {
    req.session.authenticated = true;
    res.redirect('/');
  } else {
    res.status(401).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Login Failed</title>
        <style>
          body { font-family: sans-serif; text-align: center; padding: 50px; }
          .error { color: #d32f2f; margin-bottom: 20px; }
          a { color: #1976d2; text-decoration: none; }
        </style>
      </head>
      <body>
        <h2 class="error">Invalid password</h2>
        <a href="/login">Try again</a>
      </body>
      </html>
    `);
  }
});

app.get('/', isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/api/apps', isAuthenticated, async (_req, res) => {
  try {
    const apps = await getApps();
    res.json(apps);
  } catch (err) {
    console.error('Error getting apps:', err);
    res.status(500).json({ error: err.message });
  }
});

// Debug endpoint
app.get('/api/debug', isAuthenticated, async (_req, res) => {
  const info = {
    dokkuRootExists: fs.existsSync(DOKKU_ROOT),
    dokkuRootScandir: null,
    dockerSocketExists: fs.existsSync(DOCKER_SOCKET),
    dockerApiOutput: null,
    dockerApiError: null,
    vhostsSample: null,
  };

  try {
    info.dokkuRootScandir = fs.readdirSync(DOKKU_ROOT);
  } catch (e) {
    info.dokkuRootScandir = `ERROR: ${e.message}`;
  }

  try {
    // No filter — list ALL containers to see what labels Dokku actually uses
    const containers = await dockerGet(`/containers/json?all=1`);
    info.dockerApiOutput = containers.map(c => ({
      name: c.Names,
      state: c.State,
      labels: c.Labels,
    }));
  } catch (e) {
    info.dockerApiError = e.message;
  }

  // Check what files exist in each app dir
  info.appDirContents = {};
  for (const app of ['dashboard', 'polyscanner']) {
    try {
      info.appDirContents[app] = fs.readdirSync(`${DOKKU_ROOT}/${app}`);
    } catch (e) {
      info.appDirContents[app] = `ERROR: ${e.message}`;
    }
  }

  res.json(info);
});

app.post('/logout', isAuthenticated, (req, res) => {
  req.session.authenticated = false;
  res.redirect('/login');
});

app.listen(PORT, () => {
  console.log(`Dashboard running on port ${PORT}`);
});
