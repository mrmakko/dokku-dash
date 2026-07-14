'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MetricsCollector } = require('../lib/metrics-collector');

function container(id, appName, processName, state = 'running') {
  return { Id: id, State: state, Labels: {
    'com.dokku.app-name': appName,
    'com.dokku.process-type': processName,
  } };
}

function stats(cpuPercent, memoryBytes, memoryLimitBytes = 1000) {
  return {
    cpu_stats: { cpu_usage: { total_usage: cpuPercent }, system_cpu_usage: 100, online_cpus: 1 },
    precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 },
    memory_stats: { usage: memoryBytes, limit: memoryLimitBytes, stats: {} },
  };
}

test('collect records containers and a same-timestamp multi-container app aggregate', async () => {
  const writes = [];
  const collector = new MetricsCollector({
    listContainers: async () => [container('one', 'alpha', 'web'), container('two', 'alpha', 'worker')],
    getStats: async id => id === 'one' ? stats(10, 100, 500) : stats(20, 200, 600),
    store: { recordRun: (timestamp, samples) => writes.push({ timestamp, samples }) },
    now: () => 1234,
  });

  const result = await collector.collect();

  assert.equal(result.timestamp, 1234);
  assert.equal(writes[0].timestamp, 1234);
  assert.deepEqual(writes[0].samples, [
    { scope: 'container', appName: 'alpha', containerId: 'one', processName: 'web', cpuPercent: 10, memoryBytes: 100, memoryLimitBytes: 500 },
    { scope: 'container', appName: 'alpha', containerId: 'two', processName: 'worker', cpuPercent: 20, memoryBytes: 200, memoryLimitBytes: 600 },
    { scope: 'app', appName: 'alpha', containerId: null, processName: null, cpuPercent: 30, memoryBytes: 300, memoryLimitBytes: 1100 },
  ]);
});

test('stopped containers stay visible with unavailable metrics and do not change aggregate totals', async () => {
  const writes = [];
  const stopped = container('old', 'alpha', 'worker', 'exited');
  const collector = new MetricsCollector({
    listContainers: async () => [container('live', 'alpha', 'web'), stopped],
    getStats: async () => stats(5, 80, 500),
    store: { recordRun: (_timestamp, samples) => writes.push(samples) },
  });
  await collector.collect();
  assert.equal(writes[0][1].containerId, 'old');
  assert.equal(writes[0][1].cpuPercent, null);
  assert.equal(writes[0][2].cpuPercent, 5);
});

test('a stats failure records nulls for that container and continues the run', async () => {
  const writes = [];
  const collector = new MetricsCollector({
    listContainers: async () => [container('bad', 'alpha', 'web'), container('good', 'alpha', 'worker')],
    getStats: async id => { if (id === 'bad') throw new Error('gone'); return stats(7, 70); },
    store: { recordRun: (_timestamp, samples) => writes.push(samples) },
    logger: { error() {}, info() {} },
  });
  const result = await collector.collect();
  assert.equal(result.failures, 1);
  assert.equal(writes[0][0].cpuPercent, null);
  assert.ok(Math.abs(writes[0][2].cpuPercent - 7) < Number.EPSILON * 10);
});

test('overlapping collection is skipped', async () => {
  let release;
  const collector = new MetricsCollector({
    listContainers: () => new Promise(resolve => { release = resolve; }),
    getStats: async () => stats(1, 1),
    store: { recordRun() {} },
  });
  const first = collector.collect();
  assert.deepEqual(await collector.collect(), { skipped: true });
  release([]);
  await first;
});

test('start schedules an immediate collection and recurring ten-minute runs, stop clears it', async () => {
  const scheduled = [];
  let cleared;
  const collector = new MetricsCollector({
    listContainers: async () => [], getStats: async () => {}, store: { recordRun() {} },
    setTimeout: (fn, delay) => { scheduled.push({ fn, delay }); return 42; },
    clearTimeout: id => { cleared = id; }, intervalMs: 600000, startupDelayMs: 100,
  });
  collector.start();
  assert.equal(scheduled[0].delay, 100);
  await scheduled[0].fn();
  assert.equal(scheduled[1].delay, 600000);
  collector.stop();
  assert.equal(cleared, 42);
});
