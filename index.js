const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const http = require('http');

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

function getUrlForApp(name) {
  // Direct path read — works even when scandir on /home/dokku is denied
  try {
    const vhostsPath = path.join(DOKKU_ROOT, name, 'VHOSTS');
    const vhosts = fs.readFileSync(vhostsPath, 'utf-8').trim().split('\n').filter(Boolean);
    if (vhosts.length > 0) return `https://${vhosts[0]}`;
  } catch (e) {}
  return '';
}

async function getApps() {
  const filters = encodeURIComponent(JSON.stringify({ label: ['com.dokku.container-type=web'] }));
  const containers = await dockerGet(`/containers/json?all=1&filters=${filters}`);

  // Deduplicate by app name — prefer 'running' state
  const appsMap = new Map();
  for (const c of containers) {
    const name = c.Labels && c.Labels['com.dokku.app-name'];
    if (!name) continue;
    if (!appsMap.has(name) || c.State === 'running') {
      appsMap.set(name, c.State);
    }
  }

  const apps = [];
  for (const [name, state] of appsMap) {
    apps.push({
      name,
      status: state === 'running' ? 'running' : 'stopped',
      url: getUrlForApp(name),
    });
  }

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
    const filters = encodeURIComponent(JSON.stringify({ label: ['com.dokku.container-type=web'] }));
    const containers = await dockerGet(`/containers/json?all=1&filters=${filters}`);
    info.dockerApiOutput = containers.map(c => ({
      name: c.Labels && c.Labels['com.dokku.app-name'],
      state: c.State,
    }));
  } catch (e) {
    info.dockerApiError = e.message;
  }

  // Try direct VHOSTS read for 'dashboard' app as a sample
  try {
    info.vhostsSample = fs.readFileSync(`${DOKKU_ROOT}/dashboard/VHOSTS`, 'utf-8').trim();
  } catch (e) {
    info.vhostsSample = `ERROR: ${e.message}`;
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
