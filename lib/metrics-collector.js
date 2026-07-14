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
    this.setInterval = options.setInterval || setInterval;
    this.clearInterval = options.clearInterval || clearInterval;
    this.intervalMs = options.intervalMs || 10 * 60 * 1000;
    this.startupDelayMs = options.startupDelayMs === undefined ? 1000 : options.startupDelayMs;
    this.running = false;
    this.timer = null;
    this.interval = null;
    this.active = null;
    this.stopped = true;
  }

  collect() {
    if (this.active) return Promise.resolve({ skipped: true });
    this.running = true;
    this.active = this._collect();
    return this.active.finally(() => {
      this.running = false;
      this.active = null;
    });
  }

  async _collect() {
    const timestamp = this.now();
    const containers = await this.listContainers();
      const samples = [];
      const runningById = new Map();
      let failures = 0;
      for (const container of containers) {
        const identity = containerIdentity(container);
        if (!identity.appName || !identity.containerId) continue;
        runningById.set(identity.containerId, container.State === 'running');
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
          const runningSamples = appSamples.filter(sample => runningById.get(sample.containerId));
          if (runningSamples.some(sample => !Number.isFinite(sample[field]))) return null;
          return runningSamples.reduce((sum, sample) => sum + sample[field], 0);
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
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    const tick = async () => {
      try { return await this.collect(); } catch (error) { this.logger.error(`Metrics collection failed: ${error.message}`); return { error }; }
    };
    this.timer = this.setTimeout(tick, this.startupDelayMs);
    this.interval = this.setInterval(tick, this.intervalMs);
  }

  async stop() {
    this.stopped = true;
    if (this.timer !== null) this.clearTimeout(this.timer);
    if (this.interval !== null) this.clearInterval(this.interval);
    this.timer = null;
    this.interval = null;
    if (this.active) {
      try { await this.active; } catch (error) {
        this.logger.error(`Active metrics collection failed during shutdown: ${error.message}`);
      }
    }
  }
}

module.exports = { MetricsCollector };
