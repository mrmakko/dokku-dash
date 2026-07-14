'use strict';

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function calculateCpuPercent(stats) {
  const current = stats && stats.cpu_stats;
  const previous = stats && stats.precpu_stats;
  const total = current && current.cpu_usage && current.cpu_usage.total_usage;
  const previousTotal = previous && previous.cpu_usage && previous.cpu_usage.total_usage;
  const system = current && current.system_cpu_usage;
  const previousSystem = previous && previous.system_cpu_usage;
  if (![total, previousTotal, system, previousSystem].every(finiteNumber)) return null;

  const cpuDelta = total - previousTotal;
  const systemDelta = system - previousSystem;
  const cpuCount = current.online_cpus
    || (current.cpu_usage.percpu_usage && current.cpu_usage.percpu_usage.length);
  if (cpuDelta <= 0 || systemDelta <= 0 || !finiteNumber(cpuCount) || cpuCount <= 0) return null;
  return (cpuDelta / systemDelta) * cpuCount * 100;
}

function calculateMemory(stats) {
  const memory = stats && stats.memory_stats;
  const memoryLimitBytes = memory
    && finiteNumber(memory.limit)
    && memory.limit > 0
    && memory.limit < Number.MAX_SAFE_INTEGER
    ? memory.limit
    : null;
  if (!memory || !finiteNumber(memory.usage)) return { memoryBytes: null, memoryLimitBytes };
  const cache = memory.stats && (
    finiteNumber(memory.stats.total_inactive_file)
      ? memory.stats.total_inactive_file
      : memory.stats.inactive_file
  );
  const memoryBytes = Math.max(0, memory.usage - (finiteNumber(cache) ? cache : 0));
  return { memoryBytes, memoryLimitBytes };
}

function containerIdentity(container) {
  const labels = container.Labels || container.labels || {};
  const appName = labels['com.dokku.app-name'] || null;
  const processName = labels['com.dokku.process-type'] || null;
  return {
    appName,
    containerId: container.Id || container.id || null,
    processName,
  };
}

module.exports = { calculateCpuPercent, calculateMemory, containerIdentity };
