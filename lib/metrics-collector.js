'use strict';

const { calculateCpuPercent, calculateMemory, containerIdentity } = require('./docker-metrics');

class MetricsCollector {
  constructor(options) {
    this.listContainers = options.listContainers;
    this.getStats = options.getStats;
    this.store = options.store;
    this.now = options.now || Date.now;
    this.logger = options.logger || console;
    this.setTimeout = options.setTimeout || setTimeout;
    this.clearTimeout = options.clearTimeout || clearTimeout;
    this.intervalMs = options.intervalMs || 10 * 60 * 1000;
    this.startupDelayMs = options.startupDelayMs === undefined ? 1000 : options.startupDelayMs;
    this.running = false;
    this.timer = null;
    this.stopped = true;
  }

  async collect() {
    if (this.running) return { skipped: true };
    this.running = true;
    const timestamp = this.now();
    try {
      const containers = await this.listContainers();
      const samples = [];
      let failures = 0;
      for (const container of containers) {
        const identity = containerIdentity(container);
        if (!identity.appName || !identity.containerId) continue;
        let cpuPercent = null;
        let memoryBytes = null;
        let memoryLimitBytes = null;
        if (container.State === 'running') {
          try {
            const stats = await this.getStats(identity.containerId);
            cpuPercent = calculateCpuPercent(stats);
            ({ memoryBytes, memoryLimitBytes } = calculateMemory(stats));
          } catch (error) {
            failures += 1;
            this.logger.error(`Metrics unavailable for container ${identity.containerId}: ${error.message}`);
          }
        }
        samples.push({ scope: 'container', ...identity, cpuPercent, memoryBytes, memoryLimitBytes });
      }
      const byApp = new Map();
      for (const sample of samples) {
        if (!byApp.has(sample.appName)) byApp.set(sample.appName, []);
        byApp.get(sample.appName).push(sample);
      }
      for (const [appName, appSamples] of byApp) {
        const aggregate = field => {
          const values = appSamples.map(sample => sample[field]).filter(Number.isFinite);
          return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
        };
        samples.push({
          scope: 'app', appName, containerId: null, processName: null,
          cpuPercent: aggregate('cpuPercent'), memoryBytes: aggregate('memoryBytes'),
          memoryLimitBytes: aggregate('memoryLimitBytes'),
        });
      }
      this.store.recordRun(timestamp, samples);
      this.logger.info(`Collected ${samples.length} metric samples (${failures} failures)`);
      return { skipped: false, timestamp, samples: samples.length, failures };
    } finally {
      this.running = false;
    }
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    const schedule = delay => {
      this.timer = this.setTimeout(async () => {
        try { await this.collect(); } catch (error) { this.logger.error(`Metrics collection failed: ${error.message}`); }
        if (!this.stopped) schedule(this.intervalMs);
      }, delay);
    };
    schedule(this.startupDelayMs);
  }

  stop() {
    this.stopped = true;
    if (this.timer !== null) this.clearTimeout(this.timer);
    this.timer = null;
  }
}

module.exports = { MetricsCollector };
