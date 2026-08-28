# PicWall2

A photo wall application built with **Bun 1.4.0**, **Hono**, and **React**.

## Security and privacy

This is a **public photo wall**, not a private photo vault. Photos, original downloads, names, tags, dates, and selected EXIF fields are public without login. Originals are preserved byte-for-byte and may contain GPS coordinates, serial numbers, names, or other metadata not shown by the UI. Remove sensitive metadata before upload. Deletion stops new application reads but cannot revoke downloaded copies or media already cached by browsers/CDNs (media has a one-year immutable cache lifetime).

Admin writes require a registered Passkey. See [SECURITY.md](SECURITY.md) for deployment requirements and vulnerability reporting, and the [pre-release security review](docs/security-audit-2026-08-28.md) for findings and release checks. Do not expose an older deployment before applying the authentication fixes.

The project uses the existing MIT license; dependencies retain their own licenses. Each production build generates `/licenses.txt` with the project license, bundled dependency notices, and runtime dependency source links. Keep this file with the deployed assets. The container also includes `LICENSE`. ExifReader declares MPL-2.0; review its notice and source availability when redistributing the application or image. This inventory does not cover the container operating system or third-party web fonts.

## Features

- **Native runtime**: Bun serves HTTP, bundles the frontend, watches source files, and runs tests.
- **Photo processing**: `Bun.Image` generates WebP thumbnails up to 600 px wide and previews within 1600 × 1600 px, with EXIF orientation and no upscaling. ExifReader retains camera metadata.
- **Storage**: a version 2 SQLite catalog separates photo identities from SHA-256 addressed original assets and versioned derivatives. Local storage and S3-compatible object storage share the same keys and maintenance tools.
- **Authentication**: built-in, user-verifying Passkeys with one-time CLI enrollment and server-side sessions.
- **Frontend**: React, CSS Modules, Motion, and Wouter, with Vite's React/CSS Modules hot reloading running on Bun.

## Getting Started

Install **Bun 1.4.0**. The version is pinned in `.bun-version`, `package.json`, Docker, and CI. Node.js and pnpm are not required.

```bash
bun --version # 1.4.0
bun install --frozen-lockfile
cp .env.example .env.local
```

Set `BASE_URL` to the exact browser-facing origin. HTTPS is required except on loopback development; no path, query, fragment, or credentials are allowed. `AUTH_ROOT` is an independent private SQLite directory and defaults to `./data/auth`. Missing `BASE_URL` leaves the public gallery available but disables login and administrative access. Changing the origin requires an explicit reset because WebAuthn credentials are bound to the relying-party domain.

```env
BASE_URL="http://localhost:5173"
AUTH_ROOT="./data/auth"
PORT=3000
STORAGE_TYPE="local"
LIBRARY_ROOT="./data/library-v2"
```

Bun loads `.env.local` automatically. Before the first login, issue a setup token on the server and enter it at `/login`:

```bash
bun run auth init
```

The token expires after 10 minutes and is invalidated after its single successful use. Re-running `init` replaces an unused token. There is no public registration, password, email, or OIDC fallback. After setup, open **Admin → Security** and add a Passkey on another device or hardware key. Up to 10 Passkeys are supported; adding or removing one requires a fresh Passkey verification, and the final key cannot be removed.

Sessions expire after seven days and are stored as SHA-256 token hashes in `AUTH_ROOT/auth.sqlite`; browser cookies are HttpOnly, SameSite=Strict, and Secure under HTTPS. Challenges expire after five minutes, bind to a browser cookie and purpose, and are consumed before signature verification. Logout uses same-origin `POST /api/auth/logout`; GET does not log users out.

If every Passkey is lost, stop the service and run the destructive recovery command. It revokes all Passkeys, sessions, setup tokens, and in-progress ceremonies, then prints a new 10-minute setup token:

```bash
bun run auth reset --confirm
```

Restart the service and enroll at `/login`. Use `bun run auth status` to inspect enrollment without exposing the token. For a built deployment, replace `bun run auth` with `bun dist/scripts/auth.js`. Always use the same environment, `AUTH_ROOT`, and filesystem user as the server.

### Development

```bash
bun run dev
```

Open [http://localhost:5173](http://localhost:5173). `bun run --parallel` starts Vite on Bun and the Bun backend watcher together. Vite proxies API requests and images to port 3000, preserving the browser-facing Host for CSRF validation. `PORT` changes the backend port; `VITE_PORT` changes the frontend port.

Vite is retained only for development: Bun 1.4.0's native React HMR server produced undefined CSS Module bindings in browser testing. Production JavaScript, HTML, and CSS are built by `Bun.build`; no Vite server runs in production.

### Build, test, and run

```bash
bun run typecheck
bun audit
bun test
bun run build
bun run start
```

The build type-checks the frontend, backend, scripts, and tests, then outputs browser assets to `dist/public`, their manifest to `dist/assets.json`, a Bun server to `dist/server/index.js`, and maintenance/import commands to `dist/scripts/`. Keep the whole `dist` directory when deploying. Production requires the production dependencies in `node_modules`; it does not need the source files or a Node.js runtime.

Tests use synthetic Passkey key pairs, temporary databases/files, a local S3 fixture, and a local production server. They do not access a real authenticator, photo library, or S3 bucket.

### Runtime limits and caching

`GET /api/photos` retains the full-array response for existing clients and the admin page. The photo wall uses `GET /api/photos?limit=60&cursor=...&tag=...`, returning `{ photos, nextCursor }`; `limit` is 1–100 and the opaque cursor must be used with the same tag. A SQLite sorting index supports stable date/creation-time/ID ordering without offset pagination. `GET /api/tags` returns all tags, ordered by most recent photo date, including tags on undated photos.

List, page, and tag responses cache serialized JSON and return an ETag. Clients revalidate with `If-None-Match`; unchanged responses return `304` without a body. Uploads, deletions, and tag updates invalidate caches. Each process holds one full list plus up to 64 cached pages; image files are not cached in this way. The photo wall renders only cards near the viewport and loads more pages as you scroll. Filtering starts a new query and cancels old requests. A library has one writer: stop the server before importing or running maintenance.

Uploads enter a bounded FIFO queue before multipart parsing, buffer reads, thumbnail/preview generation, and storage writes. `IMAGE_CONCURRENCY` defaults to `2` active uploads and `IMAGE_QUEUE_SIZE` to `8` waiting uploads per process. A full queue returns `503` with `Retry-After: 2`; cancelled waiting requests leave the queue. `IMAGE_MAX_PIXELS` defaults to `60000000` (60 MP), enforced by Bun before decoding. Set concurrency to `1` on memory-constrained hosts, and measure peak memory before increasing concurrency or the pixel limit. These are job and source-size limits, not a fixed memory cap. The offline directory importer reads and imports one source file at a time.

Cards and the detail viewer use `srcset` to choose a thumbnail or preview. The detail viewer loads the original only when you click **Load original** or **Open original**. It releases original-image Blob URLs when switching photos or closing, cancels pending downloads, and clears progress after failures. A new asset becomes visible only after both derivatives are ready; derivative failures retain the original and a durable retry job.

Production uses Bun native routes for built assets. JS, CSS, and HTML have build-time Brotli and gzip variants, negotiated with `Accept-Encoding` and `Vary`, with encoding-specific ETags and HEAD support. Hashed JS/CSS are immutable for one year; HTML and favicon revalidate. The small built assets are read once at startup, so deploy new builds by restarting the server. API and image paths never fall through to HTML.

Run `bun scripts/benchmark_photo_cache.ts 10000 200` to compare uncached, cached, conditional, and paged list responses using synthetic metadata in a temporary database. It reports median/P95 response-generation time and body size; it does not measure network latency or real-image upload throughput.

### Import a photo directory

```bash
bun run import:photos ./photos --root ./data/library-v2
```

Stop the server first. The importer supports JPEG, PNG, WebP, GIF, and BMP. An absolute source path is journaled, so repeating the same directory skips unchanged sources. A changed file at the same source path fails explicitly. Different source files with identical bytes keep separate photo identities while sharing one asset; equal filenames in different directories do not collide. Invalid images fail without creating a mislabeled thumbnail. GIF thumbnails use the first frame. Production deployments use `bun dist/scripts/import_photos.js` with the same arguments.

## Library Layout and Maintenance

`LIBRARY_ROOT` defaults to `data/library-v2`. The directory contains `catalog.sqlite`, its SQLite sidecars, `writer-lock.sqlite`, and (for local storage) `objects/`. Original keys are `originals/<first 2 hash characters>/<next 2>/<SHA-256>`; derivative keys include the asset hash, rendering recipe hash, variant kind, and output checksum. Names, tags, dates, EXIF, and creation timestamps live in the catalog and do not determine object paths. Multiple photo records may share an asset. Deletion hides a photo immediately and retains its data until explicit garbage collection.

All commands require an explicit `--root` and acquire the same writer lock as the server. Stop every server/importer using the catalog first; do not remove lock files to bypass a running writer. In production, replace `bun scripts/library.ts` below with `bun dist/scripts/library.js`.

```bash
bun scripts/library.ts check --root ./data/library-v2
bun scripts/library.ts duplicates --root ./data/library-v2
bun scripts/library.ts retry --root ./data/library-v2
bun scripts/library.ts rebuild --root ./data/library-v2
bun scripts/library.ts gc --root ./data/library-v2 --retention-days 7
bun scripts/library.ts gc --root ./data/library-v2 --retention-days 7 --apply
bun scripts/library.ts export --root ./data/library-v2 --output ./manifest-v2.json
bun scripts/library.ts backup --root ./data/library-v2 --output ./backups/library-2026-08-28
bun scripts/library.ts restore --root ./restored-library --from ./backups/library-2026-08-28
bun scripts/library.ts retry --root ./restored-library
bun scripts/library.ts check --root ./restored-library
```

`check` verifies SQLite integrity/foreign keys, every recorded object's SHA-256 and length, and reports missing, corrupt, and unreferenced objects, unfinished jobs, and assets without a complete published recipe. Those findings produce a nonzero exit status; leftover local staging files are reported separately. `duplicates` reports active photo IDs sharing an asset. `retry` runs unfinished/failed derivative jobs; `rebuild` schedules current-recipe derivatives for every asset. Originals are never regenerated from previews.

`gc` is a dry run by default. `--apply` is required to delete anything; retention must be at least seven days. It removes expired deleted photo records, unreferenced assets, retired derivatives, old orphan objects, and recognized local staging files left by an interrupted write. Active photos and recently deleted photos protect their shared original and current derivatives. Objects and staging files without a trustworthy old modification timestamp are retained. Review the JSON plan before applying; garbage collection is irreversible without a backup.

Manifest export refuses existing destinations and any path inside the library. A backup must use a new directory outside the library and contains `catalog.sqlite` from a consistent SQLite snapshot, all verified originals under `objects/`, and `manifest.json`. The manifest is written last as the completion marker. Derivatives are reproducible and are not copied. Keep the backup private: it includes filenames, tags, and EXIF. Backups do not include the independent `AUTH_ROOT`, deployment configuration, or S3 credentials; back those up separately. Treat an auth backup as credential material, preserve its SQLite sidecars while the service is stopped, and restore it only with the same `BASE_URL`. Restoring auth backups can restore previously revoked sessions and keys; reset authentication after restoring a stale or suspect backup.

Restore requires an empty catalog and empty object namespace in an isolated destination. It verifies all original hashes before restoring photo metadata and queues fresh derivatives. Run `retry` and `check` before pointing `LIBRARY_ROOT` at the restored directory. `restore` uses `manifest.json` plus `objects/`, so the exported manifest and matching original hierarchy can also be assembled independently. The SQLite backup preserves the full operational catalog for recovery, while manifest restore intentionally creates fresh jobs rather than replaying old queue state.

## S3 Storage

Metadata still lives in `LIBRARY_ROOT/catalog.sqlite`, even in S3 mode. Persist the entire library directory, including SQLite sidecars and the writer lock database.

```env
STORAGE_TYPE="s3"
S3_ENDPOINT="https://<accountid>.r2.cloudflarestorage.com"
S3_BUCKET="picwall-bucket"
S3_ACCESS_KEY_ID="your_access_key"
S3_SECRET_ACCESS_KEY="your_secret_key"
S3_REGION="auto"
S3_PREFIX="library-v2/"
S3_CDN_URL="https://cdn.example.com"
```

Set `S3_REGION` to the bucket's AWS region when using AWS S3. `S3_PREFIX` is a dedicated v2 namespace ending in `/`; legacy `uploads/`, `thumbnails/`, and `previews/` namespaces are rejected. The catalog records its object-store identity and rejects an accidental bucket/prefix switch. `S3_CDN_URL` is optional: application media routes redirect to the corresponding CDN object. Without a CDN, set `S3_PRESIGNED_READS=true` to redirect to a five-minute native S3 signed GET URL. Redirect responses use `private, no-store` so an expired signature is not cached. These options do not make a public photo wall private; the bucket can be private while application media routes remain public.

With neither option, images stream through the application. Direct viewing requires a browser-accessible CDN/S3 endpoint; **Load original** also requires CORS allowing GET from your site (or use **Open original**). Configure and validate these settings for your provider before enabling signed reads. Migration only reads legacy keys and writes new objects under the v2 prefix; it never removes legacy files or keys. Use a distinct empty prefix for restore. Do not share a v2 prefix between independent catalogs: reference tracking and garbage collection are scoped to one catalog.

## Docker

```bash
docker build -t picwall2 .
```

The image uses `oven/bun:1.4.0-alpine`, installs from `bun.lock`, runs the build and regression tests, and copies only production dependencies and build output into the final image.

Mount these paths to preserve data across container recreation:

- `/usr/src/app/data`: the Passkey database under `auth/`, plus the v2 catalog, SQLite sidecars, and local objects under `library-v2/`.
- `/usr/src/app/files`: only needed when mounting legacy source files for explicit migration.

Pass configuration with `--env-file .env.local` or your deployment environment. The entrypoint uses `LOCAL_USER_ID` (default `1000`) and `LOCAL_GROUP_ID` (defaults to the UID), then drops privileges to the `bun` user. Existing mounted files must be writable by that UID/GID. An explicit Docker `--user` is also supported; in that case prepare mount permissions yourself. Run setup in the container as the same runtime user, for example `docker exec --user bun <container> bun dist/scripts/auth.js init`.

## Upgrading an Existing Deployment

1. Stop the old application and back up `data/` and `files/`. Legacy OIDC sessions cannot be migrated; initialize a Passkey after the upgrade. Preserve the entire SQLite directory, including any `-wal` and `-shm` files. Keep an S3 backup if the old originals are remote.
2. Install from `bun.lock` or rebuild the Docker image. Replace deployment commands that still use Node.js or pnpm with the Bun commands above. Automatic in-place legacy migration is disabled.
3. Run the explicit migration below. `--source-root` is the old project root containing `data/` and `files/`; `--root` is a separate v2 library (the default subdirectory `data/library-v2` is allowed). `--offline` confirms that the legacy service is stopped. The reader opens `data/photos.db` read-only and falls back to `data/photos_db.json` when the SQLite catalog is absent or empty. It reads originals from `files/uploads/<legacy id>` and regenerates derivatives without changing old files.
4. Review every reported failure, run `retry`, then `check`. Successful originals and source metadata are journaled for restart; rerunning unchanged sources does not duplicate photos. Changed original bytes or metadata are explicit conflicts, not silently skipped. Names, tags, dates, EXIF, and available creation timestamps are preserved; photo IDs become independent opaque IDs.
5. Point `LIBRARY_ROOT` at the checked destination and start the new service. Keep the legacy source and backup until the new deployment has been verified. Do not run the old and new service together against an actively changing source.

```bash
bun scripts/library.ts migrate --source-root /srv/legacy-picwall --root /srv/legacy-picwall/data/library-v2 --offline
bun scripts/library.ts retry --root /srv/legacy-picwall/data/library-v2
bun scripts/library.ts check --root /srv/legacy-picwall/data/library-v2
```

For legacy S3, add `--source-storage s3`. The migration reads `uploads/<legacy id>` using `SOURCE_S3_ENDPOINT`, `SOURCE_S3_BUCKET`, `SOURCE_S3_REGION`, `SOURCE_S3_ACCESS_KEY_ID`, and `SOURCE_S3_SECRET_ACCESS_KEY` (each falls back to the corresponding `S3_*` value). Destination storage uses normal `STORAGE_TYPE`/`S3_*` configuration and the isolated `S3_PREFIX`. The source catalog remains local and read-only. The old and new object stores may differ.

Bun.Image does not decode AVIF/HEIC/TIFF on Linux. Convert new uploads in those formats to JPEG, PNG, or WebP before importing. If a legacy original cannot be decoded, migration reports it and does not claim a complete upgrade; preserve the old library until the source is reconciled. WebP quality is set to 80 and will not have exactly the same size or appearance as the former AVIF output.

The `flatted` override in `package.json` keeps ESLint's cached transitive dependency on a patched 3.x version.

## Project Structure

- `src/`: React application and CSS Modules.
- `server/`: Hono routes, Bun server entries, image processing, storage adapters, and SQLite metadata.
- `scripts/`: Bun build and photo import scripts.
- `tests/`: Bun regression tests.
- `public/`: static source assets.
- `dist/`: generated production output.

## License

MIT
