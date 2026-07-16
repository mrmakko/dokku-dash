'use strict';

const path = require('node:path');
const express = require('express');
const { buildMockApps, buildMockSystemUsage } = require('./lib/mock-apps');

function createPreviewApp(options = {}) {
  const app = express();
  const publicDirectory = path.join(__dirname, 'public');
  const now = options.now || Date.now;

  app.get('/api/apps', (_request, response) => response.json(buildMockApps(now())));
  app.get('/api/system', (_request, response) => response.json(buildMockSystemUsage()));
  app.post('/logout', (_request, response) => response.sendStatus(204));
  app.use(express.static(publicDirectory));
  app.get(['/login', '*'], (_request, response) => response.sendFile(path.join(publicDirectory, 'dashboard.html')));

  return app;
}

if (require.main === module) {
  const port = Number.parseInt(process.env.PREVIEW_PORT || '4173', 10);
  createPreviewApp().listen(port, '127.0.0.1', () => {
    console.log(`Dashboard preview: http://localhost:${port}`);
  });
}

module.exports = { createPreviewApp };
