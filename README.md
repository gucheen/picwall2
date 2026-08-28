# PicWall2

A photo wall for browsing and sharing your photos, built with Bun, Hono, and React.

## Features

- Responsive photo wall with tag filters and infinite scrolling.
- Photo details with camera metadata, previews, and access to originals.
- Editable photo titles and location markers with external map links.
- Admin page for batch uploads, tagging, and deletion.
- Automatic WebP thumbnails and previews; identical originals share storage.
- Local disk or S3-compatible object storage.
- Passkey login with support for backup devices, without an external identity provider.

> Photos, originals, and metadata are public. Login protects administration only. Originals retain embedded metadata such as GPS coordinates; remove sensitive information before uploading. Deleted photos may remain in downloaded or cached copies. See [Security](SECURITY.md).

## Quick start with Docker Compose

For a new installation. If you already have a photo library, follow the [upgrade guide](docs/operations.md#upgrade-from-an-older-version) before starting the new service.

Copy the example files into your deployment directory:

```bash
cp compose.example.yaml compose.yaml
cp .env.example .env
chmod 600 .env
```

Edit `.env` and replace the image reference and domain with your own:

```dotenv
PICWALL_IMAGE=ghcr.io/your-account/picwall2:your-tag
BASE_URL=https://photos.example.com
STORAGE_TYPE=local
```

For S3, configure [S3 storage](#s3-storage) before the first start.

The Compose template targets `linux/amd64` and exposes `127.0.0.1:3000`. Configure an HTTPS reverse proxy on the host to forward your domain to that port. A proxy in another container needs a shared Docker network instead. `BASE_URL` must match the browser-facing origin, with no path; changing it later requires Passkey recovery.

```bash
docker compose up -d
docker compose exec --user bun picwall bun dist/scripts/auth.js init
```

Open `https://photos.example.com/login`, enter the setup token, and register a Passkey. The token is private, single-use, and expires after 10 minutes. Then add a backup Passkey under **Admin → Security**.

Compose persists `./data` on the host: `library-v2/` contains the photo catalog and local objects, and `auth/` contains login data. Keep this directory even when using S3. The container paths are fixed by the template; existing data must be writable by `LOCAL_USER_ID` / `LOCAL_GROUP_ID` (default `1000:1000`). Keep `.env` private and out of Git.

## Using PicWall2

- **Browse:** open `/`, filter by tag, and click a photo to see its details. Choose **Load original** or **Open original** for the full image.
- **Manage:** open `/admin` to upload photos, edit their details, or move photos to trash. Choose **Edit** beside a photo to set its title, location, and tags; batch tagging remains available.
- **Large libraries:** photos, trash, and unfinished processing jobs have separate 60-item pages. Select-all and Shift-selection apply to the current photo page. Edits update the current rows without reloading the whole library.
- **Uploads:** up to two files upload concurrently. Saved originals are processed in the background; the processing panel refreshes while jobs are queued or running. Busy-server and connection failures retry automatically with the same upload identity. **Retry failed uploads** retries only failed files; keep the page open to retain their retry identities.
- **Locations:** enter a place name and optionally both latitude and longitude in WGS84 decimal degrees. **View on Google Maps** opens a pin at the coordinates; a name alone offers **Search on Google Maps**. Leave fields blank to remove them. Titles do not rename original files. Saved locations are public; GPS is not automatically copied into the location marker.
- **Manage Passkeys:** open `/admin/security` to add or remove keys. Keep a backup key; there is no password or email fallback.
- **Import a folder, back up, or recover access:** see the [operations guide](docs/operations.md).

Supported import formats are JPEG, PNG, WebP, GIF, and BMP. Convert AVIF, HEIC, or TIFF before importing on Linux. The default image limit is 60 megapixels; other limits are listed in [`.env.example`](.env.example).

## S3 storage

Add these settings to `.env`, using your provider's endpoint, bucket, credentials, and region:

```dotenv
STORAGE_TYPE=s3
S3_ENDPOINT=https://s3.example.com
S3_BUCKET=picwall
S3_ACCESS_KEY_ID=your-access-key
S3_SECRET_ACCESS_KEY=your-secret-key
S3_REGION=auto
S3_PREFIX=library-v2/
```

For AWS S3, use the bucket's actual region. Use a dedicated prefix ending in `/`; do not use the legacy `uploads/`, `thumbnails/`, or `previews/` prefixes or share a prefix between independent catalogs.

Photo metadata still lives in the local `data/library-v2/catalog.sqlite`. Once initialized, the catalog is bound to its storage type and, for S3, its endpoint, bucket, and prefix. Changing these settings does not migrate an existing library.

Images stream through the application by default. Optional `S3_CDN_URL` or `S3_PRESIGNED_READS=true` enables direct reads; see [direct image delivery](docs/operations.md#direct-image-delivery) before enabling either.

## Local development

Requires **Bun 1.4.0**.

```bash
bun install --frozen-lockfile
cp .env.example .env.local
bun run auth init
bun run dev
```

Bun loads `.env.local` automatically. The example uses `BASE_URL=http://localhost:5173`; open that address and enroll at `/login`. HTTPS is required outside loopback development.

```bash
bun run typecheck
bun test
bun run build
bun run start
```

Run `bun run test:browser` for an isolated, browser-based regression suite with generated photos and no deployment credentials. See [browser tests](docs/browser-tests.md) for the automated checks and manual keyboard/mobile checks.

The production server defaults to port 3000. Set `BASE_URL` to its browser-facing origin before initializing a production account, and keep development and production data separate. Production deployments need the complete `dist/` directory and production dependencies.

## License

[MIT](LICENSE). Dependencies retain their own licenses; keep the generated `/licenses.txt` with deployed assets and preserve its dependency notices and source links.
