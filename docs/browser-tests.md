# Browser regression

Run `bun run test:browser`, open the printed loopback URL, and click **Run browser checks**. The runner uses production assets, an isolated temporary catalog, generated images, and a test-only administrator session. It ignores deployment `.env` files. No browser automation dependency is required.

The seven browser checks cover:

1. Bounded, focusable gallery cards.
2. Switching filters while an older response is delayed.
3. Failed original downloads, retry, and focus restoration after closing.
4. Detail navigation across a page boundary and disabled first-photo navigation.
5. Bounded admin pages and page-local selection.
6. Batch tags and metadata editing without reloading the entire catalog.
7. Busy upload retries with a stable idempotency key, and absence of unbounded list requests.

Checks run through real DOM events in a same-origin iframe. Separately verify trusted keyboard input in **Open gallery**:

- Tab to a photo; Enter and Space open it.
- Tab/Shift+Tab stay inside the open dialog.
- Arrow keys navigate and Escape closes; focus returns to the current photo card.
- Check a narrow viewport: the dialog image, metadata, actions, and admin pagination remain reachable without horizontal page overflow.

Restart the fixture for a fresh run. Ctrl+C stops it and removes only its temporary data. It also stops after 30 minutes. The fixture is not included in the production image or asset manifest and must not be deployed as an application entry point.

`bun test` runs the separate unit and HTTP suites, including upload concurrency, partial batch failures, pagination cursors, shutdown waiting, idempotent upload retries, and transactional cache invalidation. It does not start a browser or automatically run this interactive suite.

## HTTP client notes

- `POST /api/upload` returns `202` with `status: "pending"` once the original and processing job are durable, or `200` if its shared asset is already ready. A pending response is not a processing failure.
- Send a UUID `Idempotency-Key` for each logical upload and reuse it on retries. Reusing it with different bytes returns `409`. This identity is kept in the live catalog, not in exported backup manifests; it lasts until the associated photo is permanently collected.
- `POST /api/jobs/retry` starts recovery and returns `202`; inspect `GET /api/jobs?limit=60` for counts and unfinished jobs.
- Parameterless list endpoints retain their previous response shapes for existing clients. The admin UI always supplies a page limit.
