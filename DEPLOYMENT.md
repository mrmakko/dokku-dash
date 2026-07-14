# Dokku deployment runbook

The commands below assume the Dokku application is named `dashboard`. Run them
on the Dokku host (or prefix them with the appropriate SSH command).

## Preflight

Inspect the server before making changes. In particular, record the current
domain from the first command as `CURRENT_DOMAIN`; this runbook intentionally
does not guess it.

```sh
dokku domains:report dashboard
dokku storage:report dashboard
dokku config:keys dashboard
dokku plugin:list
```

Do not paste secret values into tickets or logs. Generate a new, long random
`SESSION_SECRET` with a trusted password generator and retain the existing
dashboard password.

## Persistent metrics storage and configuration

Create a named storage entry, mount it at the path used by the application,
and configure production values:

```sh
dokku storage:create dashboard-metrics
dokku storage:mount dashboard dashboard-metrics --container-dir /app/data
dokku config:set dashboard NODE_ENV=production METRICS_DB_PATH=/app/data/metrics.sqlite SESSION_SECRET='<NEW_RANDOM_SECRET>' DASHBOARD_PASSWORD='<EXISTING_PASSWORD>'
dokku ps:restart dashboard
```

`config:set` normally restarts the application, but the explicit restart also
ensures the newly attached mount is active. Confirm the attachment and config
keys without printing secrets:

```sh
dokku storage:report dashboard
dokku config:keys dashboard
dokku logs dashboard --tail
```

Log in, request `/api/apps`, wait for a collection, and confirm that metrics
are returned. Then record the database checksum or file metadata, restart the
application, and confirm the same database still exists and its history is
still visible:

```sh
dokku run dashboard ls -l /app/data/metrics.sqlite
dokku ps:restart dashboard
dokku run dashboard ls -l /app/data/metrics.sqlite
```

The one-off `run` container receives run-phase storage mounts, so it sees the
same `/app/data` path as the web process. Never delete or recreate the storage
entry as a troubleshooting step: that can destroy the metrics history.

Include the named storage entry in host backups. SQLite backups must be
transactionally consistent: stop the app briefly before copying the database,
or use SQLite's online backup command from a compatible SQLite client. A raw
copy while writes are occurring may omit WAL data. Periodically test restore
into a separate location.

## Reversible migration to `dokku.proofnest.org`

Keep `CURRENT_DOMAIN` available until every check below passes.

1. From `dokku domains:report dashboard`, save the actual existing hostname as
   `CURRENT_DOMAIN`. Do not substitute an assumed main domain.
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
   dokku domains:remove dashboard <CURRENT_DOMAIN>
   dokku domains:report dashboard
   ```

If validation fails before step 6, leave the old domain in place and continue
using it while correcting DNS, TLS, or application configuration. If a problem
is discovered immediately after removal, restore it with:

```sh
dokku domains:add dashboard <CURRENT_DOMAIN>
```

## References

- [Dokku persistent storage](https://dokku.com/docs/advanced-usage/persistent-storage/)
- [Dokku environment variables](https://dokku.com/docs/configuration/environment-variables/)
- [Dokku domain configuration](https://dokku.com/docs/configuration/domains/)
- [Dokku SSL configuration](https://dokku.com/docs/configuration/ssl/)
- [Dokku backup and recovery](https://dokku.com/docs/advanced-usage/backup-recovery/)
- [dokku-letsencrypt commands](https://github.com/dokku/dokku-letsencrypt)
