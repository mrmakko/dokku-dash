'use strict';

function escapeHtml(text) {
  if (text == null) return '';
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return String(text).replace(/[&<>"']/g, character => map[character]);
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function formatCpu(value) {
  return finiteNumber(value) ? `${value.toFixed(1)}%` : 'Unavailable';
}

function formatBytes(value) {
  if (!finiteNumber(value)) return 'Unavailable';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = Math.max(0, value);
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit++;
  }
  return unit === 0 ? `${Math.round(amount)} ${units[unit]}` : `${amount.toFixed(1)} ${units[unit]}`;
}

function formatMemory(value, limit) {
  const usage = formatBytes(value);
  return usage === 'Unavailable' || !finiteNumber(limit) ? usage : `${usage} / ${formatBytes(limit)}`;
}

function formatAxisValue(value, field) {
  if (field === 'cpuPercent') return `${Number(value.toFixed(1))}%`;
  return formatBytes(value);
}

function renderSparkline(history, field, label, now = Date.now()) {
  const windowStart = now - 24 * 60 * 60 * 1000;
  const rows = (Array.isArray(history) ? history : []).filter(row => finiteNumber(row && row.timestamp) && row.timestamp >= windowStart && row.timestamp <= now);
  const valid = rows.filter(row => finiteNumber(row && row.timestamp) && finiteNumber(row[field]));
  const width = 320;
  const height = 72;
  const plot = { left: 48, right: 4, top: 5, bottom: 9 };
  if (!valid.length) {
    return `<svg class="sparkline sparkline-empty" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(label)}: no data"><text x="160" y="39" text-anchor="middle">No data yet</text></svg>`;
  }

  const maxValue = Math.max(...valid.map(row => row[field]), 1);
  const plotWidth = width - plot.left - plot.right;
  const plotHeight = height - plot.top - plot.bottom;
  const x = timestamp => plot.left + ((timestamp - windowStart) / (now - windowStart)) * plotWidth;
  const y = value => plot.top + (1 - value / maxValue) * plotHeight;
  const segments = [];
  let segment = [];
  let previousTimestamp = null;

  for (const row of rows) {
    const present = row && finiteNumber(row.timestamp) && finiteNumber(row[field]);
    const missingInterval = present && previousTimestamp != null && row.timestamp - previousTimestamp > 15 * 60 * 1000;
    if (!present || missingInterval) {
      if (segment.length) segments.push(segment);
      segment = [];
    }
    if (present) {
      segment.push(row);
      previousTimestamp = row.timestamp;
    } else {
      previousTimestamp = null;
    }
  }
  if (segment.length) segments.push(segment);

  const paths = segments.map(points => {
    const commands = points.map((row, index) => `${index ? 'L' : 'M'} ${x(row.timestamp).toFixed(1)} ${y(row[field]).toFixed(1)}`).join(' ');
    return `<path d="${commands}" vector-effect="non-scaling-stroke"></path>`;
  }).join('');
  const ticks = [maxValue, maxValue / 2, 0].map(value => {
    const tickY = y(value);
    return `<g class="sparkline-tick"><line x1="${plot.left}" y1="${tickY.toFixed(1)}" x2="${width - plot.right}" y2="${tickY.toFixed(1)}"></line><text x="${plot.left - 5}" y="${tickY.toFixed(1)}" text-anchor="end" dominant-baseline="middle">${escapeHtml(formatAxisValue(value, field))}</text></g>`;
  }).join('');
  const scaleLabel = `vertical scale 0 to ${formatAxisValue(maxValue, field)}`;
  return `<svg class="sparkline" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(`${label}, ${scaleLabel}`)}">${ticks}${paths}</svg>`;
}

function renderMetric(label, value, detail = '') {
  return `<div class="metric"><span class="metric-label">${label}</span><strong class="metric-value">${escapeHtml(value)}</strong>${detail ? `<small class="metric-detail">${escapeHtml(detail)}</small>` : ''}</div>`;
}

function renderContainers(appName, containers) {
  if (!containers.length) return '';
  const rows = containers.map(container => `<tr>
    <td><span class="process-name">${escapeHtml(container.processName || 'unknown')}</span><small>${escapeHtml(String(container.containerId || '').slice(0, 12))}</small></td>
    <td>${escapeHtml(container.state || 'unknown')}</td>
    <td>${escapeHtml(formatCpu(container.cpuPercent))}</td>
    <td>${escapeHtml(formatMemory(container.memoryBytes, container.memoryLimitBytes))}</td>
  </tr>`).join('');
  return `<details class="container-details">
    <summary>Containers (${containers.length})</summary>
    <div class="table-scroll"><table><caption class="sr-only">Current container metrics for ${escapeHtml(appName)}</caption>
      <thead><tr><th scope="col">Process</th><th scope="col">State</th><th scope="col">CPU</th><th scope="col">RAM / limit</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </details>`;
}

function renderAppCard(app, now = Date.now()) {
  const metrics = app.metrics || {};
  const current = metrics.current || {};
  const peaks = metrics.peaks7d || {};
  const history = metrics.history24h || [];
  const containers = metrics.containers || [];
  const metaRows = [];
  if (app.uptime) metaRows.push(`<div class="meta-row"><span class="meta-label">Uptime</span><span class="meta-value">${escapeHtml(app.uptime)}</span></div>`);
  if (app.lastCommit) {
    const message = String(app.lastCommit.message || '');
    const shortMessage = message.length > 40 ? `${message.slice(0, 40)}…` : message;
    metaRows.push(`<div class="meta-row"><span class="meta-label">Last deploy</span><span class="meta-value"><code>${escapeHtml(app.lastCommit.hash)}</code> ${escapeHtml(shortMessage)} <span class="meta-when">${escapeHtml(app.lastCommit.when)}</span></span></div>`);
  }
  const status = String(app.status || 'unknown');
  const statusClass = /^[a-z0-9_-]+$/i.test(status) ? status.toLowerCase() : 'unknown';
  const url = /^https?:\/\//i.test(String(app.url || '')) ? String(app.url) : '';
  return `<article class="app-card">
    <div class="app-header"><div class="app-name">${escapeHtml(app.name)}</div><span class="status-badge status-${statusClass}">${escapeHtml(status)}</span></div>
    ${metaRows.length ? `<div class="app-meta">${metaRows.join('')}</div>` : ''}
    <div class="metrics-grid">
      ${renderMetric('Current CPU', formatCpu(current.cpuPercent))}
      ${renderMetric('Current RAM used', formatBytes(current.memoryBytes), finiteNumber(current.memoryLimitBytes) ? `Limit: ${formatBytes(current.memoryLimitBytes)}` : '')}
      ${renderMetric('7-day CPU peak', formatCpu(peaks.cpuPercent))}
      ${renderMetric('7-day RAM peak', formatBytes(peaks.memoryBytes))}
    </div>
    <div class="charts">
      <figure><figcaption>CPU · 24 hours</figcaption>${renderSparkline(history, 'cpuPercent', 'CPU usage over 24 hours', now)}</figure>
      <figure><figcaption>RAM · 24 hours</figcaption>${renderSparkline(history, 'memoryBytes', 'RAM usage over 24 hours', now)}</figure>
    </div>
    ${renderContainers(app.name, containers)}
    ${url ? `<div class="app-url"><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a></div>` : ''}
  </article>`;
}

function renderApps(apps, now = Date.now()) {
  if (!apps.length) return '<div class="empty">No projects deployed yet</div>';
  return `<div class="apps-grid">${apps.map(app => renderAppCard(app, now)).join('')}</div>`;
}

let activeLoad = null;
let hasSuccessfulRender = false;

function setRefreshState(state) {
  const status = document.getElementById('refresh-status');
  const button = document.getElementById('refresh-button');
  const container = document.getElementById('apps-container');
  if (button) button.disabled = state === 'loading';
  if (container && container.classList) container.classList.toggle('is-refreshing', state === 'loading');
  if (!status) return;
  status.className = `refresh-status refresh-status-${state}`;
  status.hidden = state === 'idle';
  status.textContent = state === 'loading' ? 'Refreshing…' : state === 'error' ? 'Refresh failed' : '';
}

function loadApps() {
  if (activeLoad) return activeLoad;
  const container = document.getElementById('apps-container');
  if (!hasSuccessfulRender) {
    if (container.classList) container.classList.add('loading');
    container.innerHTML = 'Loading projects...';
  }
  setRefreshState('loading');
  activeLoad = (async () => {
    try {
      const response = await fetch('/api/apps');
      if (!response.ok) throw new Error(`Request failed with ${response.status}`);
      container.innerHTML = renderApps(await response.json(), Date.now());
      if (container.classList) container.classList.remove('loading');
      hasSuccessfulRender = true;
      setRefreshState('idle');
    } catch (error) {
      if (!hasSuccessfulRender) {
        if (container.classList) container.classList.remove('loading');
        container.innerHTML = '<div class="empty">Error loading projects</div>';
      }
      setRefreshState('error');
      console.error(error);
    } finally {
      activeLoad = null;
      const button = document.getElementById('refresh-button');
      if (button) button.disabled = false;
    }
  })();
  return activeLoad;
}

async function logout() {
  await fetch('/logout', { method: 'POST' });
  window.location.href = '/login';
}

const dashboardExports = { escapeHtml, formatCpu, formatBytes, formatMemory, renderSparkline, renderAppCard, renderApps, loadApps, logout };
if (typeof module !== 'undefined' && module.exports) module.exports = dashboardExports;
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.loadApps = loadApps;
  window.logout = logout;
  loadApps();
  window.setInterval(loadApps, 30000);
}
