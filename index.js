const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 5000;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'changeme';
const DOKKU_ROOT = '/home/dokku';

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

// Check if user is authenticated
function isAuthenticated(req, res, next) {
  if (req.session.authenticated) {
    next();
  } else {
    res.redirect('/login');
  }
}

function tryExec(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    return null;
  }
}

function getUrlForApp(name) {
  // Try VHOSTS file if /home/dokku is mounted
  try {
    const vhostsPath = path.join(DOKKU_ROOT, name, 'VHOSTS');
    if (fs.existsSync(vhostsPath)) {
      const vhosts = fs.readFileSync(vhostsPath, 'utf-8').trim().split('\n').filter(Boolean);
      if (vhosts.length > 0) return `https://${vhosts[0]}`;
    }
  } catch (e) {}
  return '';
}

// Get list of Dokku apps with status — uses Docker socket as primary source
function getApps() {
  try {
    const appsMap = new Map();

    // Primary: query Docker for all Dokku web containers (running + stopped)
    const dockerOut = tryExec(
      `docker ps -a --filter 'label=com.dokku.container-type=web' --format '{{index .Labels "com.dokku.app-name"}}|{{.State}}'`
    );

    if (dockerOut) {
      for (const line of dockerOut.split('\n')) {
        const [name, state] = line.split('|');
        if (!name) continue;
        // Keep running state over stopped if app appears multiple times
        if (!appsMap.has(name) || state === 'running') {
          appsMap.set(name, state || 'stopped');
        }
      }
    }

    // Fallback: read /home/dokku directory (works if volume is mounted)
    if (appsMap.size === 0 && fs.existsSync(DOKKU_ROOT)) {
      const SKIP = new Set(['plugins', 'services', '.git', 'tls']);
      for (const item of fs.readdirSync(DOKKU_ROOT)) {
        if (item.startsWith('.') || SKIP.has(item)) continue;
        try {
          if (!fs.statSync(path.join(DOKKU_ROOT, item)).isDirectory()) continue;
        } catch (e) { continue; }

        const result = tryExec(`docker ps --filter 'label=com.dokku.app-name=${item}' --format '{{.State}}'`);
        appsMap.set(item, result || 'stopped');
      }
    }

    const apps = [];
    for (const [name, status] of appsMap) {
      apps.push({ name, status, url: getUrlForApp(name) });
    }

    return apps.sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    console.error('Error getting apps:', err);
    return [];
  }
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

app.get('/api/apps', isAuthenticated, (req, res) => {
  const apps = getApps();
  res.json(apps);
});

// Debug endpoint — shows raw diagnostic info (auth required)
app.get('/api/debug', isAuthenticated, (req, res) => {
  const info = {
    dokkuRootExists: fs.existsSync(DOKKU_ROOT),
    dokkuRootContents: null,
    dockerSocketExists: fs.existsSync('/var/run/docker.sock'),
    dockerPsOutput: null,
    dockerPsError: null,
  };

  try {
    if (info.dokkuRootExists) {
      info.dokkuRootContents = fs.readdirSync(DOKKU_ROOT);
    }
  } catch (e) {
    info.dokkuRootContents = `ERROR: ${e.message}`;
  }

  try {
    info.dockerPsOutput = execSync(
      `docker ps -a --filter 'label=com.dokku.container-type=web' --format '{{index .Labels "com.dokku.app-name"}}|{{.State}}'`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
  } catch (e) {
    info.dockerPsError = e.message;
  }

  res.json(info);
});

app.post('/logout', isAuthenticated, (_req, res) => {
  _req.session.authenticated = false;
  res.redirect('/login');
});

app.listen(PORT, () => {
  console.log(`Dashboard running on port ${PORT}`);
  console.log(`Set DASHBOARD_PASSWORD environment variable to change the password`);
});
