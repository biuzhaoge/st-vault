# Architecture and storage

[简体中文](architecture.md) · **English**

ST-Vault supports one administrator across multiple clients. A React/Vite workbench connects to Fastify through REST and SSE; one container runs Node, PostgreSQL 18 and FFmpeg for screenshots. The runtime has no browser, GPU decoding components or automatic key extractor. Dependency versions are defined by [package-lock.json](../package-lock.json) and the [Dockerfile](../deploy/Dockerfile).

## Data flow and module boundaries

Storage, HLS alignment and media directory dates remain UTC. The server validates deployment `TZ` and exposes it through the session API, giving every client the same display timezone independently of language. Calendar navigation uses local midnight/noon slots (`@date-fns/tz` handles DST); media duration remains actual UTC elapsed time. A natural day is not necessarily 24 hours.

```text
Site cookies → Account information / complete following list
Anonymous status and HLS → Shared per-broadcaster ingress → Browser live playback
                                                       → Original media → Units → Screenshots
Browser commands → HTTP → Archive worker → Library journal + PostgreSQL hot indexes
```

| Module                                                                                                                  | Responsibility                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [account](../apps/server/src/account) / [provider](../apps/server/src/provider)                                         | Account sync and anonymous upstream protocols; credentials never enter anonymous media requests                      |
| [network](../apps/server/src/network) / [ingest](../apps/server/src/ingest)                                             | Routing preferences, manual CDN tests and switching, shared fragment producers and buffers                           |
| [capture](../apps/server/src/capture) / [live](../apps/server/src/live)                                                 | Automatic recording policy and browser live sessions                                                                 |
| [archive](../apps/server/src/archive) / [library](../apps/server/src/library) / [database](../apps/server/src/database) | Media reads, units and commands, commit/recovery and database lifecycle                                              |
| [previews](../apps/server/src/previews) / [runtime](../apps/server/src/runtime)                                         | Image caches, screenshot jobs, clocks, budgets, health and shutdown order                                            |
| [http](../apps/server/src/http) / [api-schema](../packages/api-schema/src)                                              | Authentication, validation, authorized interfaces and shared contracts                                               |
| [UI](../apps/ui/src)                                                                                                    | App coordinates the workbench; features organize business functions, design/shared reuse assets, locales manage text |

## Status, recording and networking

“Record all models” is a persistent recording default, not an aggregate of individual switches. One archive transaction updates the default and all non-archived models. Newly added or re-followed models inherit it; routine list refreshes and online transitions preserve individual choices. Archiving still stops recording. The policy recovers with the portable library journal and uses the existing synchronization channel. An absent policy defaults to off; previous batch-operation intent is not inferred.

Status is evidence with an observation time and finite lease, not an indefinitely valid boolean. Failed/UNKNOWN results neither immediately overwrite known status nor renew it. A different known state requires an additional anonymous observation; confirmation backdates the transition to the first valid candidate observation. Privacy revocation does not wait for history confirmation. Restart and lease expiry preserve unknown gaps rather than inventing offline or continuous online states. Implementation and failure tests are in [provider](../apps/server/src/provider) and [archive](../apps/server/src/archive).

History is paginated by increasing event ID. Occurrence and detection times are separate, so late confirmation does not disturb read cursors. Opening History shows the latest entry and keeps it in view as entries arrive or the layout changes. Scrolling up preserves the reading position. Program events record normal shutdowns and abnormal shutdowns discovered on restart. The last heartbeat is only a lower bound on failure time. Events, status and read positions belong to the recoverable media library; the UI no longer draws orange downtime coverage blocks.

Each broadcaster shares one normal upstream production path. Live playback consumes buffered media while recording commits independently in order; it does not wait for disk publication. Recording preserves the highest available source quality without transcoding. HLS PROGRAM-DATE-TIME is preferred for wall-clock alignment. Fragments without reliable time remain unlocated rather than using download time as broadcast time.

The website origin is locked after account connection and shared by list and anonymous metadata and status requests. HLS defaults to `edge-hls.doppiocdn.net` and then uses the saved manual choice. On a switch, each live producer cancels its old requests and resolves the selected node while retaining its published buffer and recording queue. Manual testing samples up to 2 MiB of real media per node in sequence and uses the result for display and sorting.

## Recording units and UI consistency

A complete source fragment belongs to one stable recording unit. Units form at roughly minute cadence without cutting video at natural-minute boundaries; a brief interruption does not itself create a new identity. The representative image prefers a decodable frame in the unit's first fragment. Growing units retain their sample anchor and URL. Images, selection snapping, favorites and deletion share the unit identity.

Live time, playback cursor and committed-media end are separate. Clicking an image seeks without freezing the live window; dragging a selection fixes the range. The server produces limited gaps and compressed page cells; clients must not infer page numbers from elapsed minutes. An image not yet generated differs from absent media.

Favorites are durably accepted and logically protect media before batched materialization; later members of an open unit inherit protection. Deletion durably accepts an intent and logically hides media before member preparation and physical reclamation. Acceptance seals selected open units so subsequent recording does not enter an old task. Unfinished steps resume after restart. Select-all uses a frozen selection token plus explicit exceptions, not a complete browser-side library list. Personal revisions and deletion generations reject stale results.

Delete unliked preserves the favorite exclusions in effect at admission. If a favorite is removed during preparation, the same durable transaction records the matching exclusions in affected deletion intents. The original deletion continues across restarts. The status panel treats a terminal cancellation under the earlier favorite revision guard as historical and reports current issues separately.

UI reads and cancellation are owned by business scopes. SSE signals invalidation, not complete business data. Timeline reads currently use three rows per packet and two packets in flight, with bounded caches prioritizing visible rows. Unchanged subject objects are reused; connection geometry is locally subscribed; animations follow actual geometry changes with batched measurements before writes. Exact playback updates do not redraw the whole coverage band, and archive time mapping uses a cumulative index with binary search.

Native scrolling keeps the full height of the filtered directory and mounts only rows near the viewport. Virtual spacers draw cover placeholders and both rails during large jumps. Nearby offscreen covers preload only from the local cache, with transfer slots reserved for visible rows. Scrolling across rows pauses directory timeline reads and retains already painted detail. Newly exposed rows show their covers and rails during motion, even with cached data. After 120 ms without scrolling, they paint cached detail and load missing data in batches. The calendar grid and live marker span the viewport height. View bounds determine tick geometry, and the display clock moves the live marker. The player's focus timeline updates independently. Restoration and the player connection retain exact offsets.

After scrolling settles, a span changes, the view pages sideways, or the filter changes, the viewport reveals both tracks from top to bottom, including cached rows. During paging, the outer scene follows the shared horizontal pan while the tracks fade in inside it. Requests still run in parallel. A lower row that finishes early waits in the cache for preceding rows to become ready or report an error. A soft sweep indicates pending data and fades out as the tracks fade in. Offscreen and scrolling placeholders stay static, and painted rows stay visible during background refreshes.

The browser cover cache keeps image bytes. Each mounted image creates its own display URL and releases it on unmount, so a returning row can still display the cached bytes.

Each coverage row uses one SVG with at most 15 density paths, preserving gaps and subpixel markers. Wide views favor whole-minute buckets aggregated in PostgreSQL. Fully covered minutes use their minute boundaries, and partial minutes use the original endpoints. Empty coverage returns an empty seen projection. Pending deletions read visible media precisely. Rendering aggregation preserves the original data used by screenshots, selection snapping, favorites, and deletion.

Sorting, filtering and membership changes share viewport-only transitions. Final ordering and the browsing anchor are committed first; Web Animations then translates visible rows. Distant destinations stop at the viewport edge. Exit DOM is capped at about one screen for 360ms, without mounting distant rows or loading their images; neighbors fill the gaps. Interrupted updates continue from current visual positions, while scrolling, selection gestures and view changes take priority. Covers and timelines move together, with the selection and player connection following. Timing and easing reuse existing motion tokens; no animation dependency is added.

The account avatar and username stack above the covers. Filters and navigation share one row and the same control styling. The viewport slider keeps its pill shape during dragging, and both ends of its track stay visible. Each date is centered on the ruler itself. Nearby hour numbers yield to date labels while division lines stay at their original times. The cover column derives its width from the shared row height and the 16:9 aspect ratio. The ruler aligns with the start of each timeline. Virtual scrolling, the selection and the player connection use the same row height.

The account, key, CDN, settings, status and history panels share a header, spacing, form controls and status styles. Each panel uses a width suited to its contents and keeps that width across languages. Its height follows the content, and one region handles vertical scrolling when needed.

## Concurrency and scheduling

[execution-policy.ts](../apps/server/src/runtime/execution-policy.ts) plans network, decoder, file IO, publication and database capacity from effective CPU, memory and container constraints. Recording has no fixed room count, but buffers and queues remain bounded. More concurrency does not guarantee proportional HDD throughput.

Media visibility first locates candidate fragments or recording units, then checks indexed membership in accepted deletions. During a unit-based deletion, directory sorting uses the latest remaining visible unit. Live playback, recording supervision, and image jobs only request the subject identity and status they use. Concurrent directory reads share one query, and task summaries use the background read pool. A rolled-back busy write can be retried. An uncertain publication still triggers archive recovery. The status panel groups tasks under Recording, Data Sync, Media Processing, and Archive and Storage. Each task has its own progress, schedule, or diagnostic row. Archive health, disk space, retention, and integrity scans share a group and keep separate diagnostics. A retry runs only the independent recovery action for its item. Bound-site checks validate the expected configuration payload, and archive checks read revision indexes for media, events, and personal data. Image versions that have not changed keep the cached file. Static image transport failures can use the verified mirror, retaining the original content version and reusing a working route. Routine heartbeat and manual site testing remain in diagnostics and the account panel.

The sync pulse reads subject state and the media, event, and personal-data revisions. Views fetch the full directory or unread count when their data changes. Read-only POSTs emit no invalidation. Newly seen evidence notifies the timeline on its own topic. Timeline aggregation reads minute summaries and boundary details in one query. Point lookup and coverage repair use the actual overlap, with a partial index for long fragments. Cleanup marks objects in batches and publishes only the affected recording-unit range.

Initial workbench reads wait up to 250 ms for SSE `ready`. A late connection or reconnection refreshes the active views. The timeline batch reader owns its initial load, and the SSE subscription handles subsequent invalidations. Changes to the configured heartbeat interval keep the stream connected.

The [sync state reader](../apps/server/src/http/sync-state.ts) derives invalidations from media revisions and subject observations. The [SSE transport](../apps/server/src/http/sync.ts) owns connections, ordered delivery and backpressure. The snapshot and focus views subscribe to the selected subject. The directory batch reader retains its usable data and refreshes the affected rows. A cached offscreen row refreshes when it returns. A broad invalidation takes precedence when messages coalesce.

The [timeline data hooks](../apps/ui/src/features/timeline/use-track-data.ts) own read scopes, invalidation and lifetime for the directory and focus view. The [workbench client](../apps/ui/src/features/timeline/workbench-read.ts) owns request parameters and deletion-protection demand. The [status history reader](../apps/server/src/archive/status-history.ts) uses the interval-end index to find the first overlap and returns the first page in the same query. Later pages advance by start time in batches of up to 128 intervals under the same read-only snapshot.

The coverage reader checks for an active deletion job or a deleted recording unit with remaining footage in one SQL round trip. An active job selects the visible-segment path immediately. Other reads check for remaining footage first.

Seen coverage starts from visible recording units in the requested window and looks up seen progress by unit primary key. The same bounded query computes viewed prefixes and unread suffixes. Rendering paints both projections against coverage, so a subpixel gap stays empty and a growing tail preserves the viewed prefix. Reclassification paints directly at its UTC coordinates instead of moving an earlier color surface.

The [system status route](../apps/server/src/http/system.ts) assembles read-only status independently of HTTP composition. The status summary and snapshot view share one deletion inventory. The [deletion observer](../apps/ui/src/features/snapshots/use-deletion-jobs.ts) merges status snapshots and command acknowledgements, applying task versions and terminal states to delayed replies. It can recover through the dedicated endpoint when the inventory is unavailable.

Database pools separate general reads, playback, background reads, snapshots and writes. Foreground batches alternate fairly with bounded background steps. Recording-unit backfill is background work. The single journal writer guarantees ordered logs and fsync consistency. Interactive and playback read-only transactions limit each SQL statement to 15 seconds. Connection-pool wait is timed separately. Connections are discarded when rollback fails.

A workbench disconnect stops new rows and releases the coverage request's wait on the shared recording-unit index. Workbench coverage and status history propagate cancellation through the read-only RPC. A pending pool lease is returned when granted. An issued SQL statement settles before its transaction rolls back and releases the slot. Pool wait, in-flight SQL and rollback contribute to request drain time.

The status panel groups sync, covers, recording, screenshots, deletion, favorite materialization, retention, integrity and checkpoints. A shared business clock schedules work without overlapping slow runs. Decoding, reconnection and timeout are operation lifecycles rather than one panel task per timer. Normal shutdown stops producers first, drains accepted work, then closes archiving and PostgreSQL.

To diagnose a delay, identify what starts the job and compare its scheduler timestamps, domain state and resource-pool wait.

| Owner                                                                                                                                                     | Trigger and recovery                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Business clock](../apps/server/src/runtime/sync-clock.ts)                                                                                                | Checks every 250 ms with a default 5-second interval. A running subscription skips overlapping ticks, records rejected runs and checks again on later ticks.                                                                                                                                      |
| [Recording supervisor](../apps/server/src/capture/supervisor.ts) / [status evidence](../apps/server/src/provider/status-evidence.ts)                      | The heartbeat rotates through monitored subjects. Policy and capacity changes can also trigger reconciliation. The sweep deadline stops new observations while admitted requests and writes settle. Lease expiry is checked independently, and private evidence revokes the recording generation. |
| [Screenshot jobs](../apps/server/src/previews/jobs.ts)                                                                                                    | Media commits, queue wakes and historical scans trigger work. The scheduler checks every 250 ms by default and audits every 10 seconds. Jobs and retry times persist, and restart reclaims unfinished claims.                                                                                     |
| [Retention and integrity](../apps/server/src/runtime/resources.ts) / [archive health](../apps/server/src/runtime/archive-health.ts)                       | The business clock checks capacity. Retention and integrity checks run at least 60 seconds apart. Archive health retains one probe at a time and checks storage conditions before requesting recovery.                                                                                            |
| [Deletion and favorite materialization](../apps/server/src/http/media-selection.ts) / [checkpoints](../apps/server/src/database/portable-transactions.ts) | Command admission wakes background work, and startup and heartbeat resume it. Journal size and elapsed time trigger checkpoints. A failed checkpoint backs off and retains the snapshots and logs required for recovery.                                                                          |

The [recording rotation](../apps/server/src/capture/rotation.ts) chooses the next subject and cursor using the urgent set and a pending lookup. An ordinary sweep takes subjects in cursor order. A manual request enables a priority lookup. The supervisor owns deadlines, policy rechecks, leases and recording generations.

`capture_polling` reports latency distributions and counts when the first sweep settles and at least 60 seconds apart thereafter. It separates admission wait, upstream observation, durable acknowledgement, tail and rotation. Task status shows sweeps still in progress. After a complete empty screenshot scan rotation, roster discovery checks again at the earliest cooldown or after 5 seconds. Media commits and deletions wake their work, and job claims keep the 250 ms cadence. Committed changes and audits refresh task statistics.

## Storage and recovery

`data` contains deployment-private configuration and PostgreSQL hot indexes; `media` is the portable library. Separate SSD/HDD mounts are supported. Database storage must be local, and only one instance may write a library.

```text
data/
  postgres/18/                    PostgreSQL cluster
  private/                        Configuration master key and database credentials
  logs/                           Rotated logs
  backups/                        Frozen copies when upgrading legacy databases
media/
  library.json                    Library identity and checkpoint references
  catalog/                        Current and previous NDJSON checkpoints
  postgres-journal/               Ordered commit logs
  subjects/stripchat-<ID>/
    images/                       Cover and avatar
    recordings/YYYY-MM-DD/HH/     Original fragments, bucketed by UTC date/hour
    recordings/unlocated/         Media without reliable wall-clock location
    recordings/.staging/          Unpublished writes
    thumbnails/YYYY-MM-DD/HH/     JPEGs and source-validation metadata
```

The broadcaster key is `stripchat:<ID>`; names and automatically recorded former names are metadata. Paths are relative to the library root. Day/hour directories bound directory size, while requests use database indexes instead of rescanning video files. PIN, cookies, address keys and private network configuration are excluded from media checkpoints.

Media is written temporarily, fsynced and atomically published. Actual database row changes are fsynced to the media journal before committing hot indexes and acknowledging callers. Checkpoints pin a consistent snapshot and stream it without loading the whole database into memory. Current/previous checkpoints and required logs are retained. Missing indexes are rebuilt from them. Invalid complete records or sequence gaps cause explicit failure rather than silently discarding corruption.

Screenshots are recoverable background work; valid existing JPEGs are reused after image and source checks. Physical deletion does not hold the recording write lock for a long historical cleanup. Work is ordered per broadcaster and bounded across broadcasters. Unlink failure after a committed tombstone is retried without marking the entire library corrupt.

The current library manifest format is 2 and PostgreSQL catalog schema is 1. The retained format-5, dual-directory SQLite importer is a one-time upgrade path, not normal storage. Backup, movement and rollback constraints are in the [user guide](../README.en.md#backups-recovery-and-updates) and [maintenance guide](CONTRIBUTING.en.md#legacy-upgrades).
