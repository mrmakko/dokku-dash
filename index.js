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

// Get list of Dokku apps with status
function getApps() {
  try {
    const apps = [];

    if (!fs.existsSync(DOKKU_ROOT)) {
      return apps;
    }

    const items = fs.readdirSync(DOKKU_ROOT);

    items.forEach(item => {
      const itemPath = path.join(DOKKU_ROOT, item);
      const stat = fs.statSync(itemPath);

      // Skip if not a directory or if it's a hidden folder
      if (!stat.isDirectory() || item.startsWith('.')) {
        return;
      }

      // Skip dokku system folders
      if (['plugins', 'services', '.git'].includes(item)) {
        return;
      }

      let status = 'unknown';
      try {
        // Try to get container status
        const result = execSync(`docker ps --filter "label=com.dokku.app-name=${item}" --format "{{.State}}" 2>/dev/null`,
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        status = result || 'stopped';
      } catch (e) {
        status = 'error';
      }

      let url = '';
      try {
        const vhostsPath = path.join(DOKKU_ROOT, item, 'VHOSTS');
        if (fs.existsSync(vhostsPath)) {
          const vhosts = fs.readFileSync(vhostsPath, 'utf-8').trim().split('\n').filter(Boolean);
          if (vhosts.length > 0) {
            url = `https://${vhosts[0]}`;
          }
        }
      } catch (e) {
        // leave url empty
      }

      apps.push({
        name: item,
        status: status,
        url: url
      });
    });

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

app.post('/logout', isAuthenticated, (req, res) => {
  req.session.authenticated = false;
  res.redirect('/login');
});

app.listen(PORT, () => {
  console.log(`Dashboard running on port ${PORT}`);
  console.log(`Set DASHBOARD_PASSWORD environment variable to change the password`);
});
