'use strict';

const MB = 1024 * 1024;
const GB = 1024 * MB;
const TEN_MINUTES = 10 * 60 * 1000;

function makeHistory(now, cpuAt, memoryAt) {
  return Array.from({ length: 144 }, (_, index) => ({
    timestamp: now - (143 - index) * TEN_MINUTES,
    cpuPercent: Number(cpuAt(index).toFixed(1)),
    memoryBytes: Math.round(memoryAt(index)),
    memoryLimitBytes: 1024 * MB,
  }));
}

function buildMockApps(now = Date.now()) {
  const dashboardHistory = makeHistory(
    now,
    index => 4.5 + Math.sin(index / 8) * 2.2 + (index > 117 && index < 125 ? 19 : 0),
    index => (188 + Math.sin(index / 13) * 14 + (index > 92 && index < 98 ? 76 : 0)) * MB,
  );
  const workerHistory = makeHistory(
    now,
    index => 14 + Math.sin(index / 5) * 7 + (index % 43 === 0 ? 24 : 0),
    index => (410 + Math.cos(index / 11) * 38) * MB,
  );

  return [
    {
      name: 'dokku-dashboard',
      status: 'running',
      uptime: 'Up 3 days',
      memoryMB: 201,
      lastCommit: { hash: '4e8a27b', message: 'Improve storage metrics and card layout', when: '2 hours ago' },
      url: 'https://dokku.proofnest.org',
      storage: { containerRootFsBytes: 428 * MB, cacheBytes: 186 * MB },
      metrics: {
        current: dashboardHistory.at(-1),
        peaks7d: { cpuPercent: 31.8, memoryBytes: 291 * MB },
        history24h: dashboardHistory,
        containers: [{
          containerId: '8db2a493bc71f08e', processName: 'web', state: 'running', timestamp: now,
          cpuPercent: 5.1, memoryBytes: 201 * MB, memoryLimitBytes: 1024 * MB,
          diskRootFsBytes: 428 * MB,
        }],
      },
    },
    {
      name: 'background-worker',
      status: 'running',
      uptime: 'Up 18 hours',
      memoryMB: 422,
      lastCommit: { hash: '0d91c6a', message: 'Process queued reports', when: '18 hours ago' },
      url: 'https://worker.example.test',
      storage: { containerRootFsBytes: 1.36 * GB, cacheBytes: 742 * MB },
      metrics: {
        current: workerHistory.at(-1),
        peaks7d: { cpuPercent: 68.4, memoryBytes: 612 * MB },
        history24h: workerHistory,
        containers: [{
          containerId: 'ca5e4bd3f187d99a', processName: 'worker', state: 'running', timestamp: now,
          cpuPercent: 11.3, memoryBytes: 422 * MB, memoryLimitBytes: 1024 * MB,
          diskRootFsBytes: 1.36 * GB,
        }],
      },
    },
    {
      name: 'archived-api',
      status: 'stopped',
      uptime: null,
      memoryMB: null,
      lastCommit: { hash: '8b13fd0', message: 'Archive legacy endpoint', when: '12 days ago' },
      url: 'https://archive.example.test',
      storage: { containerRootFsBytes: 684 * MB, cacheBytes: 94 * MB },
      metrics: {
        current: null,
        peaks7d: { cpuPercent: 12.7, memoryBytes: 174 * MB },
        history24h: [],
        containers: [{
          containerId: 'a119fe8d039ce21c', processName: 'web', state: 'exited', timestamp: null,
          cpuPercent: null, memoryBytes: null, memoryLimitBytes: null,
          diskRootFsBytes: 684 * MB,
        }],
      },
    },
  ];
}

function buildMockSystemUsage() {
  return {
    ram: { totalBytes: 8 * GB, freeBytes: 3 * GB },
    disk: { totalBytes: 80 * GB, freeBytes: 23 * GB },
  };
}

module.exports = { buildMockApps, buildMockSystemUsage };
