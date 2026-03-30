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

    const html = apps.map(app => `
      <div class="app-card">
        <div class="app-name">${escapeHtml(app.name)}</div>
        <div class="app-status">
          <span class="status-badge status-${app.status}">${app.status}</span>
        </div>
        <div class="app-url">
          <a href="${escapeHtml(app.url)}" target="_blank">${escapeHtml(app.url)}</a>
        </div>
      </div>
    `).join('');

    container.innerHTML = `<div class="apps-grid">${html}</div>`;
  } catch (err) {
    container.innerHTML = '<div class="empty">Error loading projects</div>';
    console.error(err);
  }
}

function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

async function logout() {
  await fetch('/logout', { method: 'POST' });
  window.location.href = '/login';
}

loadApps();
setInterval(loadApps, 30000);
