async function loadApps() {
  const container = document.getElementById('apps-container');
  container.innerHTML = '<div class="loading">Loading projects...</div>';

  try {
    const response = await fetch('/api/apps');
    const apps = await response.json();

    if (apps.length === 0) {
      container.innerHTML = '<div class="empty">No projects deployed yet</div>';
      return;
    }

    const html = apps.map(app => {
      const metaRows = [];

      if (app.uptime) {
        metaRows.push(`<div class="meta-row"><span class="meta-label">Uptime</span><span class="meta-value">${escapeHtml(app.uptime)}</span></div>`);
      }
      if (app.memoryMB != null) {
        metaRows.push(`<div class="meta-row"><span class="meta-label">Memory</span><span class="meta-value">${escapeHtml(app.memoryMB)} MB</span></div>`);
      }
      if (app.lastCommit) {
        const msg = app.lastCommit.message.length > 40
          ? app.lastCommit.message.slice(0, 40) + '…'
          : app.lastCommit.message;
        metaRows.push(`<div class="meta-row"><span class="meta-label">Last deploy</span><span class="meta-value"><code>${escapeHtml(app.lastCommit.hash)}</code> ${escapeHtml(msg)} <span class="meta-when">${escapeHtml(app.lastCommit.when)}</span></span></div>`);
      }

      return `
        <div class="app-card">
          <div class="app-header">
            <div class="app-name">${escapeHtml(app.name)}</div>
            <span class="status-badge status-${app.status}">${app.status}</span>
          </div>
          ${metaRows.length ? `<div class="app-meta">${metaRows.join('')}</div>` : ''}
          ${app.url ? `<div class="app-url"><a href="${escapeHtml(app.url)}" target="_blank">${escapeHtml(app.url)}</a></div>` : ''}
        </div>
      `;
    }).join('');

    container.innerHTML = `<div class="apps-grid">${html}</div>`;
  } catch (err) {
    container.innerHTML = '<div class="empty">Error loading projects</div>';
    console.error(err);
  }
}

function escapeHtml(text) {
  if (text == null) return '';
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return String(text).replace(/[&<>"']/g, m => map[m]);
}

async function logout() {
  await fetch('/logout', { method: 'POST' });
  window.location.href = '/login';
}

loadApps();
setInterval(loadApps, 30000);
