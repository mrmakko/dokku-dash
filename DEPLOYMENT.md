# Dokku deployment runbook

The commands below assume the Dokku application is named `dashboard`. Run them
on the Dokku host (or prefix them with the appropriate SSH command).

## Preflight

Inspect the server before making changes. In particular, record the current
domain from the first command as `CURRENT_DOMAIN`; this runbook intentionally
does not guess it.

```sh
dokku version
dokku domains:report dashboard
dokku storage:report dashboard
dokku config:keys dashboard
dokku plugin:list
```

The named-storage commands below require Dokku 0.38.0 or newer. Stop and
upgrade Dokku first if `dokku version` reports an older release; do not replace
the commands with an ad-hoc host bind mount, because that would make this
runbook's backup and recovery procedure inaccurate.

Do not paste secret values into tickets or logs. Generate a new, long random
`SESSION_SECRET` with a trusted password generator and retain the existing
dashboard password. Enter both secrets interactively with shell history
disabled; do not put literal values in a command copied into shell history.

## Persistent metrics storage and configuration

Create a named storage entry, mount it at the path used by the application,
and configure production values:

The secret-entry block requires Bash attached to an interactive TTY. When
connecting remotely, allocate one explicitly (for example,
`ssh -t admin@dokku-host`) before running these commands. Do not run the block
through a non-interactive script, pipe, or CI job.

```bash
dokku storage:create dashboard-metrics
dokku storage:mount dashboard dashboard-metrics --container-dir /app/data
set +o history
read -r -s -p 'New SESSION_SECRET: ' SESSION_SECRET; printf '\n'
read -r -s -p 'Existing DASHBOARD_PASSWORD: ' DASHBOARD_PASSWORD; printf '\n'
dokku config:set dashboard NODE_ENV=production METRICS_DB_PATH=/app/data/metrics.sqlite SESSION_SECRET="$SESSION_SECRET" DASHBOARD_PASSWORD="$DASHBOARD_PASSWORD"
unset SESSION_SECRET DASHBOARD_PASSWORD
set -o history
dokku ps:restart dashboard
```

Run this only in a private, trusted administrator session. Interactive `read`
keeps literal secrets out of shell history, and `unset` removes the shell
variables afterward. Like most environment-variable CLIs, `config:set` may
briefly expose its arguments to privileged local process inspection; avoid a
shared host session and rotate either secret if exposure is suspected.

`config:set` normally restarts the application, but the explicit restart also
ensures the newly attached mount is active. Confirm the attachment and config
keys without printing secrets:

```sh
dokku storage:report dashboard
dokku config:keys dashboard
dokku logs dashboard --tail
```

Log in, request `/api/apps`, wait for a fresh collection, and confirm that
metrics are returned. Then capture the identity of one application sample from
the last 20 minutes, restart, and assert that the exact row still exists:

```bash
MARKER=$(dokku run dashboard node -e "const D=require('better-sqlite3')('/app/data/metrics.sqlite',{readonly:true}); const r=D.prepare(\"SELECT id,timestamp FROM samples WHERE scope='app' AND timestamp>=? ORDER BY id DESC LIMIT 1\").get(Date.now()-20*60*1000); if(!r) throw new Error('no recent application sample; wait for collection'); console.log(r.id+':'+r.timestamp)")
printf 'sample before restart: %s\n' "$MARKER"
dokku ps:restart dashboard
dokku run dashboard node -e "const D=require('better-sqlite3')('/app/data/metrics.sqlite',{readonly:true}); const p=process.argv[1].split(':').map(Number); const r=D.prepare('SELECT 1 FROM samples WHERE id=? AND timestamp=?').get(p[0],p[1]); if(!r) throw new Error('sample did not survive restart'); console.log('sample preserved')" "$MARKER"
```

The final command must print `sample preserved`; otherwise it exits non-zero.
This checks one known recent row, so normal retention cleanup and new collector
writes cannot create a false failure. Also confirm the same history through
`/api/apps`. The one-off `run` container receives run-phase storage mounts, so
it sees the same `/app/data` path as the web process. Never delete or recreate
the storage entry as a troubleshooting step: that can destroy the metrics
history.

Include the named storage entry in host backups. SQLite backups must be
transactionally consistent: stop the app briefly before copying the database,
or use SQLite's online backup command from a compatible SQLite client. A raw
copy while writes are occurring may omit WAL data. Periodically test restore
into a separate location.

## Reversible migration to `dokku.proofnest.org`

Keep `CURRENT_DOMAIN` available until every check below passes.

1. From `dokku domains:report dashboard`, save the actual existing hostname in
   a quoted shell variable. Replace the example value with the hostname only,
   without a scheme, path, whitespace, or shell metacharacters:

   ```sh
   CURRENT_DOMAIN='actual-existing-hostname.example'
   printf 'Old hostname retained for rollback: %s\n' "$CURRENT_DOMAIN"
   ```
2. Create the DNS record for `dokku.proofnest.org` pointing to the Dokku host.
   Wait until public DNS resolution returns the intended address.
3. Add the new hostname without replacing the old one:

   ```sh
   dokku domains:add dashboard dokku.proofnest.org
   dokku domains:report dashboard
   ```

4. Inspect `dokku plugin:list`. If `letsencrypt` is installed, issue or renew a
   certificate after DNS is live:

   ```sh
   dokku letsencrypt:enable dashboard
   ```

   On installations where it is already enabled and the installed plugin
   exposes renewal explicitly, use `dokku letsencrypt:renew dashboard` instead.
   Check supported commands with `dokku help letsencrypt`. If that plugin is not
   installed, use the server's existing TLS/certificate workflow; do not install
   or replace certificate tooling during this migration without a separate
   review.
5. Verify `https://dokku.proofnest.org` from outside the server:
   - the certificate is valid for the new hostname;
   - login succeeds and the secure session cookie persists;
   - authenticated `/api/apps` returns application and metric data;
   - a fresh metric appears after a collection interval;
   - metric history remains after `dokku ps:restart dashboard`.
6. Only after all checks pass, remove the recorded old hostname:

   ```sh
   dokku domains:remove dashboard "$CURRENT_DOMAIN"
   dokku domains:report dashboard
   ```

If validation fails before step 6, leave the old domain in place and continue
using it while correcting DNS, TLS, or application configuration. If a problem
is discovered immediately after removal, restore it with:

```sh
dokku domains:add dashboard "$CURRENT_DOMAIN"
```

## References

- [Dokku persistent storage](https://dokku.com/docs/advanced-usage/persistent-storage/)
- [Dokku environment variables](https://dokku.com/docs/configuration/environment-variables/)
- [Dokku domain configuration](https://dokku.com/docs/configuration/domains/)
- [Dokku SSL configuration](https://dokku.com/docs/configuration/ssl/)
- [Dokku backup and recovery](https://dokku.com/docs/advanced-usage/backup-recovery/)
- [dokku-letsencrypt commands](https://github.com/dokku/dokku-letsencrypt)
