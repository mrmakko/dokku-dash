# Container Performance History Design

## Goal

Extend the Dokku dashboard with lightweight performance monitoring for every
application and its containers. The dashboard must show current CPU and memory
usage, a low-resolution 24-hour history, and one rolling seven-day peak value
for each metric.

The feature must remain small enough for a pet-project server and must not
require Prometheus or another external monitoring service.

## User Interface

Each application card shows:

- current application CPU usage;
- current application memory usage and configured memory limit when available;
- the highest CPU usage observed during the rolling last seven days;
- the highest memory usage observed during the rolling last seven days;
- compact CPU and memory charts covering the last 24 hours;
- an expandable list of the application's Dokku containers, including process
  name, state, current CPU, current memory, and memory limit.

Application values are aggregates across all running containers belonging to
the application. CPU percentages and memory bytes from containers observed in
the same collection run are summed. A stopped container contributes zero to
the application total but remains visible in the container breakdown.

The charts contain at most 144 samples per series because collection runs once
every 10 minutes. Missing collection periods are displayed as gaps rather than
as zero load.

## Metrics

The first version records only metrics needed for the agreed performance view:

- CPU usage as a percentage of one logical CPU. Values may exceed 100% when a
  container uses more than one core.
- Memory working-set usage in bytes, excluding reclaimable cache when the
  Docker/cgroup statistics expose it.
- Configured container memory limit in bytes, when it is finite and available.

Network and block I/O, restart count, health status, and response latency are
out of scope for this iteration. They can be added without changing the storage
model's ownership boundaries.

## Collection and Aggregation

The Express process owns a background collector. It runs shortly after startup
and then every 10 minutes. A collection run:

1. Lists all Dokku deploy containers through the Docker socket.
2. Reads one non-streaming stats response for every running container.
3. Calculates container CPU and memory values.
4. Groups containers by the `com.dokku.app-name` label.
5. Writes all container samples for the run in one SQLite transaction.
6. Writes an application aggregate sample for that same timestamp.
7. Updates hourly peak buckets and removes expired data.

Runs never overlap. If one run is still active when the next interval arrives,
the new run is skipped and logged.

All samples in a run share a single timestamp. This makes application sums and
weekly peaks comparable even though Docker requests complete at slightly
different times.

## Storage

SQLite is the only new runtime data store. The database contains three logical
datasets:

- `samples`: 10-minute container and application values retained for 24 hours;
- `hourly_peaks`: maximum application and container values per clock-hour,
  retained for seven days;
- minimal schema metadata used for migrations.

The displayed seven-day peak is the maximum hourly peak whose bucket overlaps
the rolling previous seven days. The UI displays one number for CPU and one for
memory; weekly peaks are not plotted.

The hourly peak table keeps the database small while preserving a meaningful
rolling maximum after detailed samples expire. Cleanup occurs after every
successful collection and is safe to repeat.

The database path is configured through `METRICS_DB_PATH`. On Dokku it points
to a mounted persistent storage directory so deploys and container restarts do
not erase history. Startup fails with a clear error if the database cannot be
opened or migrated; serving plausible but non-persistent history is not
acceptable.

## Backend Boundaries

The current single-file server is split only where the monitoring feature needs
clear ownership:

- Docker client: container discovery and Docker stats parsing;
- metrics store: SQLite schema, writes, retention, and history queries;
- collector: scheduling, grouping, aggregation, and collection-run locking;
- routes: authentication and serialization of application/card data.

The existing `/api/apps` response is extended with current metrics, weekly
peaks, 24-hour history, and container details. Existing fields remain compatible
with the current frontend.

Detailed history is read from SQLite, while live status and URL data continue
to come from Docker. If a current Docker stats request fails for one container,
that container reports unavailable current metrics and the remaining containers
still render.

## Error Handling and Observability

- A failure for one container does not abort the entire collection run.
- A database transaction failure rolls back the complete run so partial
  application aggregates cannot be stored.
- The API distinguishes unavailable metrics (`null`) from genuine zero usage.
- Collection summaries and failures are written to application logs without
  exposing secrets or the Docker socket response.
- The frontend shows metrics as unavailable when no successful sample exists;
  it keeps status, deploy, and URL information usable.
- The existing broad `/api/debug` endpoint is removed or gated behind an
  explicit development-only environment flag because it exposes Docker labels
  and application names.

## Security and Deployment Configuration

The monitoring deployment also moves mutable security values to configuration:

- session secret comes from a required `SESSION_SECRET` environment variable;
- production cookies use `secure: true` behind Dokku's trusted proxy;
- generated application links prefer HTTPS.

Replacing the session store is not required for a single dashboard process,
but the limitation is documented. A multi-process deployment would need a
shared session store.

## Domain Migration

After the monitoring version is deployed and verified on the current domain:

1. Mount persistent storage and set `METRICS_DB_PATH`, `SESSION_SECRET`, and the
   existing dashboard password.
2. Add `dokku.proofnest.org` to the dashboard application without removing the
   current domain.
3. Create the required DNS record and enable/renew TLS for the new hostname.
4. Verify login, `/api/apps`, metric collection, database persistence across a
   restart, and HTTPS cookie behavior through the new hostname.
5. Remove the old primary-domain mapping only after verification succeeds.

Exact server commands are deliberately deferred until execution, when the
installed Dokku version, application name, current domains, TLS plugin, and DNS
state can be inspected. The migration must keep the old hostname available as a
rollback path until the final verification passes.

## Testing

Automated tests cover:

- CPU calculation from Docker's current and previous CPU counters;
- memory working-set calculation with cgroup v1 and v2-style fields;
- aggregation of multiple running and stopped containers;
- retention of 24-hour samples and seven-day hourly peaks;
- rolling weekly peak queries at boundary timestamps;
- non-overlapping collector runs and per-container failures;
- authenticated API serialization with missing metric values.

Frontend tests cover rendering current values, chart gaps, weekly peak numbers,
and the expandable container list. A deployment smoke test confirms that the
SQLite file survives a Dokku restart or redeploy when persistent storage is
mounted.

## Acceptance Criteria

- A running application card updates current CPU and memory data on refresh.
- Its charts show no more than 24 hours of 10-minute samples.
- Its CPU and memory peak numbers reflect the maximum observed load in the
  rolling last seven days.
- Applications with multiple processes show correct aggregate and per-container
  values.
- Missing Docker data never appears as zero and does not hide other apps.
- Detailed samples and hourly peaks expire automatically at their stated
  retention boundaries.
- Metric history remains intact after a dashboard restart or redeploy.
- The dashboard works over HTTPS at `dokku.proofnest.org` before the old domain
  is removed.
