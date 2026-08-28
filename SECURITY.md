# Security policy

## Reporting a vulnerability

Do not put credentials, real session cookies, private photos, or working exploits against a live deployment in a public issue. Use the repository host's private vulnerability reporting feature if enabled, or contact the maintainer listed in `LICENSE` privately. Include the affected commit, deployment mode, impact, and a minimal reproduction using synthetic data. Maintainers should enable and test a private reporting channel before publishing the repository.

Only the latest code with the current lockfile is covered by this review. Historical revisions contain authentication vulnerabilities and must not be deployed. This project has no independent security certification or guaranteed response SLA.

## Trust boundaries

- The gallery, tags, metadata, thumbnails, previews, and originals are public. Authentication protects administration, not photo viewing.
- Original files retain their metadata, including any embedded location or identity data. Previews are not a privacy substitute for accessible originals.
- Deleted photos may remain in browser/CDN caches and in downloaded copies. Shared assets remain accessible while another active photo references them. Soft deletion and garbage collection do not revoke public copies.
- The administrator account is controlled by registered Passkeys. WebAuthn signatures, user verification, the exact Origin/RP ID, browser-bound single-use challenges, and the account user handle are checked on the server. Initial enrollment also requires a short-lived CLI token stored only as a hash.
- Library, authentication, backup, manifest, and deployment files are trusted local inputs. Do not restore backups from untrusted parties or share writable storage with untrusted users. Use one application process per library and authentication database. A restored auth backup can revive old keys and sessions; reset it after restoring a stale or suspect backup.

## Deployment requirements

1. Deploy current code and `bun.lock`; run `bun audit`, `bun run build`, and `bun test` before release. Keep Bun, dependencies, and the container base image patched.
2. Use HTTPS and the exact browser-facing `BASE_URL`. Preserve browser Origin/Fetch Metadata headers through the proxy and do not cache `/api/auth/*` or authenticated admin responses. All auth mutations require the exact Origin header; production session cookies use the `__Host-` prefix.
3. Keep `.env*`, `AUTH_ROOT`, databases/sidecars, originals, backups, exports, and credentials out of Git and container build contexts. `.env.example` contains placeholders only. Ignore rules do not remove already committed data or sanitize custom archive commands.
4. Keep `AUTH_ROOT` owner-only (`0700`) and `auth.sqlite` private (`0600`). Add at least one backup Passkey on an independent device. Sessions expire after seven days. After suspected compromise or loss of every Passkey, stop the service and run `bun run auth reset --confirm`; this revokes all credentials, sessions, and pending requests.
5. Use a least-privilege S3 key scoped to a dedicated bucket/prefix. Signed reads hide bucket credentials, not photos. Validate CDN/S3 CORS if direct reads are enabled.
6. Expose only the production server behind your reverse proxy. Keep Vite on loopback. Do not place secrets or private photos in `public/`, which is intentionally public during development.
7. Apply request rate, connection, upload-time, bandwidth, and container memory/CPU limits at the proxy/runtime. Upload queue, body and pixel limits do not prevent all denial-of-service attacks; authentication has a 32 KiB body limit, 120 mutations per minute per process, and up to 1,000 pending challenges; these are not a substitute for a per-client proxy rate limiter.
8. Apply least-privilege repository and automation permissions. Protect release branches and tags, review build configuration changes, and never expose publishing or deployment credentials to untrusted pull requests. Revoke credentials that are no longer used.

## Before making the repository public

Review all branches/tags and the staged diff, run a dedicated history secret scanner such as Gitleaks, and enable the hosting provider's secret scanning/push protection where available. Revoke any discovered secret before removing it from history; merely adding `.gitignore` is insufficient. Confirm that commit author identities and the existing MIT license attribution are intended to be public, and that any bundled assets may be redistributed. Do not publish a ZIP of the working directory with runtime files included.

See [the dated review](docs/security-audit-2026-08-28.md) for the scope, verified fixes, and remaining checks. A clean dependency audit is not proof that the application has no vulnerabilities.
