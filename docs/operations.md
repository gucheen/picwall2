# Operations

Examples use the [Compose template](../compose.example.yaml) with `./data:/usr/src/app/data`. Run commands from the deployment directory and replace example host paths with your own. Stop the service and any importer before library maintenance; never remove lock files to bypass a running writer.

The library path is `/usr/src/app/data/library-v2` **inside the container**, not `/usr/src/app` or the host path. Compose's `environment` entries take precedence over values from `.env`.

## Import a photo folder

Mount the source folder read-only and make sure the container user can read it:

```bash
docker compose stop picwall
docker compose run --rm --no-deps \
  -v /absolute/path/photos:/import:ro \
  picwall bun dist/scripts/import_photos.js /import \
  --root /usr/src/app/data/library-v2
```

The importer reads JPEG, PNG, WebP, GIF, and BMP files directly in that folder, without recursion. Repeating an import at the same mounted path skips unchanged files; changed files at an already imported path are reported as conflicts. Review failures before restarting the service.

## Check and retry

With the service stopped:

```bash
docker compose run --rm --no-deps \
  picwall bun dist/scripts/library.js retry --root /usr/src/app/data/library-v2
docker compose run --rm --no-deps \
  picwall bun dist/scripts/library.js check --root /usr/src/app/data/library-v2
```

`retry` processes unfinished or failed thumbnails and previews. `check` verifies the catalog and stored objects and reports missing, corrupt, or unreferenced objects and incomplete processing. Resolve failures and require `ok: true` before relying on a migration or restore.

Other commands use the same `bun dist/scripts/library.js <command> --root ...` form:

| Command | Use |
| --- | --- |
| `duplicates` | List photo records sharing the same original. |
| `rebuild` | Regenerate thumbnails and previews. |
| `export --output /usr/src/app/data/manifest.json` | Export metadata to a new file outside the library. |
| `gc --retention-days 7` | Preview cleanup of expired deleted photos and unreferenced objects. |

Deletion hides photos immediately; physical cleanup is separate. Review the `gc` plan and make a backup before adding `--apply`, which permanently deletes eligible data. Retention cannot be shorter than seven days. Cleanup cannot revoke downloaded or cached copies.

## Back up and restore

Stop the service and all importers first. Back up to a **new directory outside the library**:

```bash
docker compose stop picwall
docker compose run --rm --no-deps \
  picwall bun dist/scripts/library.js backup \
  --root /usr/src/app/data/library-v2 \
  --output /usr/src/app/data/backups/library-backup
```

The backup contains the catalog, verified originals, and `manifest.json`; thumbnails and previews are regenerated on restore. A failed backup without its final manifest is incomplete. In S3 mode, originals are downloaded into this local backup, so allow sufficient disk space and transfer time.

Also back up the entire `data/auth/` directory, including SQLite sidecar files, and `.env` separately while the service is stopped. The library backup does not include them. Copy backups off the server and keep them private: they contain photo metadata and authentication material.

Restore into a **separate empty library and empty object namespace**. These commands use `restored-library/` as a new S3 prefix; the override is harmless for local storage. Choose an unused prefix and keep it identical in all three commands:

```bash
docker compose run --rm --no-deps -e S3_PREFIX=restored-library/ \
  picwall bun dist/scripts/library.js restore \
  --root /usr/src/app/data/restored-library \
  --from /usr/src/app/data/backups/library-backup
docker compose run --rm --no-deps -e S3_PREFIX=restored-library/ \
  picwall bun dist/scripts/library.js retry --root /usr/src/app/data/restored-library
docker compose run --rm --no-deps -e S3_PREFIX=restored-library/ \
  picwall bun dist/scripts/library.js check --root /usr/src/app/data/restored-library
```

After successful verification, update `LIBRARY_ROOT` in Compose's `environment` and, for S3, `S3_PREFIX` in `.env` to the restored locations before starting the service.

Restore authentication data only with the same `BASE_URL`. An old auth backup can revive revoked keys and sessions; reset authentication after restoring a stale or suspect backup.

## Recover Passkey access

If every Passkey is lost, or you intentionally change `BASE_URL`, stop the service and reset authentication:

```bash
docker compose stop picwall
docker compose run --rm --no-deps picwall bun dist/scripts/auth.js reset --confirm
docker compose up -d picwall
```

This revokes **all Passkeys, sessions, and pending enrollment requests**. Keep the new setup token private, enroll at `/login` within 10 minutes, and add a backup Passkey. It does not delete photos. Run `auth.js status` instead to inspect enrollment without resetting it.

## Upgrade from an older version

Libraries already using `library-v2/catalog.sqlite` upgrade automatically from catalog schema 2 or 3 to 4 on startup. Schema 4 adds pagination indexes and a transactional public-content revision for cache invalidation; schema 2 libraries also gain titles and locations. Stop the service and back up before upgrading. The library path and object storage do not change. Older application versions cannot open schema 4; rolling back requires the pre-upgrade backup.

The migration below applies to legacy `photos.db` or `photos_db.json` libraries. Do not start the new service against those libraries before migration.

1. Stop the old service and back up its complete data directory, including SQLite sidecars, and its originals on local disk or S3. Stop the new service too if it has already been started.
2. Configure the new deployment's `.env`. `STORAGE_TYPE` and `S3_*` select the **destination**; `--source-storage` selects the **source**. Use a separate destination library and a dedicated unused S3 prefix.
3. Mount the old data directory read-only. It must contain `photos.db` or `photos_db.json`, even when old photos are in S3. The container user must be able to read it.
4. Run the migration below, then resolve reported failures and run [retry and check](#check-and-retry). `--offline` confirms that you stopped the old service; it does not stop it for you.
5. Confirm the photo count matches expectations and verification returns `ok: true`. Start the new service and initialize a Passkey as described in the [quick start](../README.md#quick-start-with-docker-compose). Legacy OIDC sessions are not migrated. Keep the source and backups until the new deployment is verified.

For **old photos in S3**, replace the example host path with the old data directory:

```bash
docker compose run --rm --no-deps \
  -v /absolute/path/old-data:/legacy/data:ro \
  picwall bun dist/scripts/library.js migrate \
  --source-root /legacy \
  --source-storage s3 \
  --root /usr/src/app/data/library-v2 \
  --offline
```

Source credentials use `SOURCE_S3_ENDPOINT`, `SOURCE_S3_BUCKET`, `SOURCE_S3_REGION`, `SOURCE_S3_ACCESS_KEY_ID`, and `SOURCE_S3_SECRET_ACCESS_KEY`, each falling back to its `S3_*` counterpart. Set the source variables only when the old store differs from the destination.

For **old photos on local disk**, change `--source-storage s3` to `--source-storage local` and add `-v /absolute/path/old-files:/legacy/files:ro` before the service name `picwall`. That directory must contain `uploads/`.

Migration preserves names, tags, dates, EXIF, and available creation timestamps, assigns new photo IDs, and regenerates previews. S3 originals are downloaded and uploaded into the new prefix, so allow extra storage and transfer time. It does not delete old files or S3 objects. Keep the same mounted source path when rerunning; unchanged sources are skipped, while changed files or metadata are reported as conflicts.

AVIF, HEIC, and TIFF originals cannot be decoded on Linux by the current image processor. Treat any such failure as an incomplete migration and keep the old originals and catalog intact.

## Configuration and permissions

| Setting | Compose value or purpose |
| --- | --- |
| `LIBRARY_ROOT` | `/usr/src/app/data/library-v2`, fixed in the Compose template. |
| `AUTH_ROOT` | `/usr/src/app/data/auth`, independent of photo storage. |
| `LOCAL_USER_ID` / `LOCAL_GROUP_ID` | Runtime ownership; UID defaults to 1000, group defaults to the UID. |
| `IMAGE_CONCURRENCY` | Active uploads per process; default 2. Use 1 on hosts with limited memory. |
| `IMAGE_QUEUE_SIZE` | Waiting uploads per process; default 8. |
| `IMAGE_MAX_PIXELS` | Maximum source pixels; default 60000000. |

Use one server process per library. Image limits do not replace proxy request limits or container memory limits.

Directories should be private to the runtime user (`700`), with private data files `600`; do not use `777`. The entrypoint adjusts only the top-level data directory's ownership, so copied files need matching ownership too. If you set Docker's `user` explicitly, prepare permissions yourself. Keep `.env` owned by the host deployment user with mode `600`.

Common errors:

- **Missing S3 credentials:** ensure Compose has `env_file: .env`, the required S3 variables are set, and no `environment` entry overrides them. Source and destination configurations are separate.
- **Unable to open database file:** check the effective container path, volume mapping, file existence, and directory/file permissions. Do not create an empty database to mask a wrong path.
- **Object store does not match this catalog:** restore the catalog's original storage configuration. Storage type, endpoint, bucket, and prefix must match; even a trailing slash in the endpoint matters. Do not edit the binding to bypass the check. If a failed first attempt left a confirmed empty catalog with zero photos and assets, stop all writers and preserve the entire target directory before initializing a fresh destination. Keep old source data and S3 objects untouched.

## Direct image delivery

Images stream through the application unless you set `S3_CDN_URL` or `S3_PRESIGNED_READS=true`. A CDN URL takes precedence; signed reads otherwise redirect to a temporary S3 URL.

The CDN or S3 endpoint must be reachable by browsers. **Load original** also needs CORS allowing GET from your site's origin; otherwise use **Open original** or keep application streaming. A private bucket and signed URLs do not make the public gallery private.

## Commands from a source checkout

Use Bun 1.4.0 and the same environment, filesystem user, `AUTH_ROOT`, and `LIBRARY_ROOT` as the server. Replace the container commands with:

- `bun run library <command> --root ./data/library-v2`
- `bun run import:photos ./photos --root ./data/library-v2`
- `bun run auth init`, `bun run auth status`, or `bun run auth reset --confirm`

Keep all offline, backup, and destination-isolation requirements above.
