const test = require('node:test');
const assert = require('node:assert/strict');

const {
  calculateCpuPercent,
  calculateMemory,
  containerIdentity,
} = require('../lib/docker-metrics');

test('calculates CPU from Docker counter deltas and permits values over 100%', () => {
  const stats = {
    cpu_stats: {
      cpu_usage: { total_usage: 900, percpu_usage: [1, 1, 1, 1] },
      system_cpu_usage: 2000,
      online_cpus: 4,
    },
    precpu_stats: {
      cpu_usage: { total_usage: 100 },
      system_cpu_usage: 1000,
    },
  };

  assert.equal(calculateCpuPercent(stats), 320);
});

test('returns null when CPU deltas are zero or absent', () => {
  assert.equal(calculateCpuPercent({}), null);
  assert.equal(calculateCpuPercent({
    cpu_stats: { cpu_usage: { total_usage: 10 }, system_cpu_usage: 10 },
    precpu_stats: { cpu_usage: { total_usage: 10 }, system_cpu_usage: 10 },
  }), null);
});

test('subtracts cgroup v1 total inactive file cache from memory usage', () => {
  assert.deepEqual(calculateMemory({ memory_stats: {
    usage: 1000,
    limit: 2000,
    stats: { total_inactive_file: 250 },
  } }), { memoryBytes: 750, memoryLimitBytes: 2000 });
});

test('subtracts cgroup v2 inactive file cache and ignores non-finite limits', () => {
  assert.deepEqual(calculateMemory({ memory_stats: {
    usage: 1000,
    limit: Number.MAX_SAFE_INTEGER,
    stats: { inactive_file: 100 },
  } }), { memoryBytes: 900, memoryLimitBytes: null });
  assert.deepEqual(calculateMemory({}), { memoryBytes: null, memoryLimitBytes: null });
});

test('extracts stable Dokku container identity', () => {
  assert.deepEqual(containerIdentity({
    Id: 'abcdef1234567890',
    Names: ['/project.web.1'],
    Labels: {
      'com.dokku.app-name': 'project',
      'com.dokku.process-type': 'web',
    },
  }), { appName: 'project', containerId: 'abcdef1234567890', processName: 'web' });
});
