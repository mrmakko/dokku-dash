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
  assert.ok(Math.abs(writes[0][1].cpuPercent - 7) < Number.EPSILON * 10);
  assert.equal(writes[0][2].cpuPercent, null);
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

test('start schedules fixed ten-minute ticks so a slow run causes the overlap lock to skip', async () => {
  const timeouts = [];
  const intervals = [];
  let release;
  const collector = new MetricsCollector({
    listContainers: () => new Promise(resolve => { release = resolve; }), getStats: async () => {}, store: { recordRun() {} },
    setTimeout: (fn, delay) => { timeouts.push({ fn, delay }); return 41; },
    setInterval: (fn, delay) => { intervals.push({ fn, delay }); return 42; },
    clearTimeout() {}, clearInterval() {}, intervalMs: 600000, startupDelayMs: 100,
  });
  collector.start();
  assert.equal(timeouts[0].delay, 100);
  assert.equal(intervals[0].delay, 600000);
  const first = timeouts[0].fn();
  assert.deepEqual(await intervals[0].fn(), { skipped: true });
  release([]);
  await first;
  await collector.stop();
});

test('an unavailable running contributor makes only its missing aggregate fields null', async () => {
  const writes = [];
  const collector = new MetricsCollector({
    listContainers: async () => [container('partial', 'alpha', 'web'), container('good', 'alpha', 'worker')],
    getStats: async id => id === 'partial'
      ? { cpu_stats: stats(2, 1).cpu_stats, precpu_stats: stats(2, 1).precpu_stats, memory_stats: {} }
      : stats(3, 30),
    store: { recordRun: (_timestamp, samples) => writes.push(samples) },
  });
  await collector.collect();
  const aggregate = writes[0].at(-1);
  assert.equal(aggregate.cpuPercent, 5);
  assert.equal(aggregate.memoryBytes, null);
  assert.equal(aggregate.memoryLimitBytes, null);
});

test('stop waits for the active collection before returning', async () => {
  let release;
  const collector = new MetricsCollector({
    listContainers: () => new Promise(resolve => { release = resolve; }),
    getStats: async () => {}, store: { recordRun() {} },
  });
  const collection = collector.collect();
  let stopped = false;
  const stopping = collector.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release([]);
  await collection;
  await stopping;
  assert.equal(stopped, true);
});

test('stop settles an active collection rejection instead of rejecting cleanup', async () => {
  let rejectCollection;
  const collector = new MetricsCollector({
    listContainers: () => new Promise((_resolve, reject) => { rejectCollection = reject; }),
    getStats: async () => {}, store: { recordRun() {} },
    logger: { error() {}, info() {} },
  });
  const collection = collector.collect();
  const stopping = collector.stop();
  rejectCollection(new Error('docker disappeared'));
  await assert.rejects(collection, /docker disappeared/);
  await assert.doesNotReject(stopping);
});
