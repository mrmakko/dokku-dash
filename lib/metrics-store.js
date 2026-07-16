'use strict';

const { DatabaseSync } = require('node:sqlite');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

class MetricsStore {
  constructor(databasePath) {
    if (!databasePath) throw new Error('Metrics database path is required');
    this.database = new DatabaseSync(databasePath);
    this.database.exec('PRAGMA journal_mode = WAL');
    this.database.exec('PRAGMA foreign_keys = ON');
    this._migrate();
    this._prepare();
  }

  _migrate() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_metadata (
        version INTEGER NOT NULL
      );
      INSERT INTO schema_metadata(version)
        SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM schema_metadata);

      CREATE TABLE IF NOT EXISTS samples (
        id INTEGER PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        scope TEXT NOT NULL CHECK(scope IN ('app', 'container')),
        app_name TEXT NOT NULL,
        container_id TEXT,
        process_name TEXT,
        cpu_percent REAL,
        memory_bytes INTEGER,
        memory_limit_bytes INTEGER,
        CHECK((scope = 'app' AND container_id IS NULL) OR
              (scope = 'container' AND container_id IS NOT NULL))
      );
      CREATE INDEX IF NOT EXISTS samples_app_time
        ON samples(app_name, scope, timestamp);

      CREATE TABLE IF NOT EXISTS hourly_peaks (
        bucket INTEGER NOT NULL,
        scope TEXT NOT NULL CHECK(scope IN ('app', 'container')),
        app_name TEXT NOT NULL,
        container_key TEXT NOT NULL,
        container_id TEXT,
        process_name TEXT,
        cpu_percent REAL,
        memory_bytes INTEGER,
        PRIMARY KEY(bucket, scope, app_name, container_key)
      );
      CREATE INDEX IF NOT EXISTS hourly_peaks_app_bucket
        ON hourly_peaks(app_name, scope, bucket);
    `);
  }

  _prepare() {
    this.insertSample = this.database.prepare(`
      INSERT INTO samples(timestamp, scope, app_name, container_id, process_name,
                          cpu_percent, memory_bytes, memory_limit_bytes)
      VALUES (@timestamp, @scope, @appName, @containerId, @processName,
              @cpuPercent, @memoryBytes, @memoryLimitBytes)
    `);
    this.upsertPeak = this.database.prepare(`
      INSERT INTO hourly_peaks(bucket, scope, app_name, container_key, container_id,
                               process_name, cpu_percent, memory_bytes)
      VALUES (@bucket, @scope, @appName, @containerKey, @containerId,
              @processName, @cpuPercent, @memoryBytes)
      ON CONFLICT(bucket, scope, app_name, container_key) DO UPDATE SET
        process_name = excluded.process_name,
        cpu_percent = CASE
          WHEN excluded.cpu_percent IS NULL THEN hourly_peaks.cpu_percent
          WHEN hourly_peaks.cpu_percent IS NULL THEN excluded.cpu_percent
          ELSE MAX(hourly_peaks.cpu_percent, excluded.cpu_percent) END,
        memory_bytes = CASE
          WHEN excluded.memory_bytes IS NULL THEN hourly_peaks.memory_bytes
          WHEN hourly_peaks.memory_bytes IS NULL THEN excluded.memory_bytes
          ELSE MAX(hourly_peaks.memory_bytes, excluded.memory_bytes) END
    `);
    this.deleteSamples = this.database.prepare('DELETE FROM samples WHERE timestamp <= ?');
    this.deletePeaks = this.database.prepare('DELETE FROM hourly_peaks WHERE bucket < ?');
    this.writeRun = (timestamp, samples) => {
      if (!Number.isFinite(timestamp)) throw new TypeError('timestamp must be finite');
      if (!Array.isArray(samples)) throw new TypeError('samples must be an array');
      this.database.exec('BEGIN IMMEDIATE');
      try {
        const bucket = Math.floor(timestamp / HOUR_MS) * HOUR_MS;
        for (const sample of samples) {
          this._validateSample(sample);
          const row = { timestamp, ...sample };
          this.insertSample.run(row);
          this.upsertPeak.run({
            bucket,
            scope: sample.scope,
            appName: sample.appName,
            containerKey: sample.containerId || '',
            containerId: sample.containerId,
            processName: sample.processName,
            cpuPercent: sample.cpuPercent,
            memoryBytes: sample.memoryBytes,
          });
        }
        this.deleteSamples.run(timestamp - DAY_MS);
        this.deletePeaks.run(Math.floor((timestamp - WEEK_MS) / HOUR_MS) * HOUR_MS);
        this.database.exec('COMMIT');
      } catch (error) {
        try {
          this.database.exec('ROLLBACK');
        } catch {
          // Preserve the original transaction error if SQLite already rolled back.
        }
        throw error;
      }
    };
  }

  _validateSample(sample) {
    if (!sample || !['app', 'container'].includes(sample.scope)) throw new TypeError('invalid sample scope');
    if (typeof sample.appName !== 'string' || !sample.appName) throw new TypeError('sample appName is required');
    if (sample.scope === 'app' && sample.containerId !== null) throw new TypeError('app sample containerId must be null');
    if (sample.scope === 'container' && (typeof sample.containerId !== 'string' || !sample.containerId)) {
      throw new TypeError('container sample containerId is required');
    }
    for (const field of ['cpuPercent', 'memoryBytes', 'memoryLimitBytes']) {
      if (sample[field] !== null && !Number.isFinite(sample[field])) throw new TypeError(`${field} must be finite or null`);
    }
  }

  recordRun(timestamp, samples) {
    this.writeRun(timestamp, samples);
  }

  getAppMetrics(appName, now) {
    const cutoff24h = now - DAY_MS;
    const cutoff7dBucket = Math.floor((now - WEEK_MS) / HOUR_MS) * HOUR_MS;
    const currentRow = this.database.prepare(`
      SELECT timestamp, cpu_percent AS cpuPercent, memory_bytes AS memoryBytes,
             memory_limit_bytes AS memoryLimitBytes
      FROM samples WHERE app_name = ? AND scope = 'app' AND timestamp > ? AND timestamp <= ?
      ORDER BY timestamp DESC, id DESC LIMIT 1
    `).get(appName, cutoff24h, now);
    const current = currentRow ? { ...currentRow } : null;
    const history24h = this.database.prepare(`
      WITH ranked AS (
        SELECT id, timestamp, cpu_percent, memory_bytes, memory_limit_bytes,
               ROW_NUMBER() OVER (
                 PARTITION BY CAST(timestamp / ? AS INTEGER)
                 ORDER BY timestamp DESC, id DESC
               ) AS bucket_rank
        FROM samples
        WHERE app_name = ? AND scope = 'app' AND timestamp > ? AND timestamp <= ?
      ), recent AS (
        SELECT * FROM ranked
        WHERE bucket_rank = 1
        ORDER BY timestamp DESC, id DESC
        LIMIT 144
      )
      SELECT timestamp, cpu_percent AS cpuPercent, memory_bytes AS memoryBytes,
             memory_limit_bytes AS memoryLimitBytes
      FROM recent
      ORDER BY timestamp ASC, id ASC
    `).all(10 * 60 * 1000, appName, cutoff24h, now).map(row => ({ ...row }));
    const peaks = this.database.prepare(`
      SELECT MAX(cpu_percent) AS cpuPercent, MAX(memory_bytes) AS memoryBytes
      FROM hourly_peaks
      WHERE app_name = ? AND scope = 'app' AND bucket >= ? AND bucket <= ?
    `).get(appName, cutoff7dBucket, now);
    const containers = this.database.prepare(`
      SELECT s.container_id AS containerId, s.process_name AS processName,
             s.timestamp, s.cpu_percent AS cpuPercent, s.memory_bytes AS memoryBytes,
             s.memory_limit_bytes AS memoryLimitBytes
      FROM samples s
      JOIN (
        SELECT container_id, MAX(timestamp) AS timestamp
        FROM samples
        WHERE app_name = ? AND scope = 'container' AND timestamp >= ? AND timestamp <= ?
        GROUP BY container_id
      ) latest ON latest.container_id = s.container_id AND latest.timestamp = s.timestamp
      WHERE s.app_name = ? AND s.scope = 'container'
      ORDER BY s.process_name, s.container_id
    `).all(appName, cutoff24h, now, appName).map(row => ({ ...row }));
    return {
      current,
      peaks7d: { cpuPercent: peaks.cpuPercent, memoryBytes: peaks.memoryBytes },
      history24h,
      containers,
    };
  }

  close() {
    this.database.close();
  }
}

module.exports = { MetricsStore };
