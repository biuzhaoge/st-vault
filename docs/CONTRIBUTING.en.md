# Development and maintenance

[简体中文](CONTRIBUTING.md) · **English**

This guide covers building, testing, releasing and recovering the project. See the [user guide](../README.en.md), [architecture](architecture.en.md) and [API](api.en.md) for usage and interfaces.

Include reproduction steps, relevant tests and risks with changes, and update documentation when behavior changes. Report security issues privately as described in [SECURITY](SECURITY.en.md). The canonical CONTRIBUTING.md and SECURITY.md files stay in docs using [GitHub-supported names and locations](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/creating-a-default-community-health-file), without duplicate root documents.

## Repository layout

| Path                      | Contents                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server`, `apps/ui`  | Server and UI, with tests alongside their modules                                                                               |
| `packages/api-schema`     | Shared types and request contracts                                                                                              |
| `compose.yml`, `deploy`   | User deployment template, development override, Dockerfile and FFmpeg build                                                     |
| `scripts`                 | Build/check entry points; benchmarks for experiments, diagnostics for explicit network probes, maintenance for legacy migration |
| `tests`                   | Synthetic e2e scenarios, runtime probes and deployment lifecycle validation                                                     |
| `docs`                    | All guides and translations, without development-phase subdirectories                                                           |
| `licenses`, `LICENSE`     | Required legal notices, not disposable development artifacts                                                                    |
| `.github`                 | Issue and PR templates and the Docker Hub release workflow                                                                      |
| `data`, `media`, `.local` | Git-ignored production state, media and local validation output, separate from source                                           |

Keep npm/workspace lockfiles, TypeScript/ESLint/Prettier configuration and Git/Docker/editor rules at the root rather than inventing custom tool paths merely to hide files. Install dependencies only in containers. Do not commit `build/` or `apps/ui/dist/`.

## Build and check

Run from the repository root without mounting production data/media:

```sh
docker build --target qa -t st-vault:qa -f deploy/Dockerfile .
docker run --rm st-vault:qa npm run check
docker run --rm --entrypoint npm st-vault:qa audit --omit=dev --audit-level=high
docker run --rm st-vault:qa sh -ec 'npm run build && npm run test:browser'
```

`check` covers formatting, lint, documentation links, source dependencies, types, tool/workspace tests and the release build. QA includes a temporary PostgreSQL cluster for real integration tests; runtime omits npm, compilers and Chromium. Targeted examples:

```sh
docker run --rm st-vault:qa npm test --workspace @st-vault/ui -- src/features/timeline/track-loader.test.ts
docker run --rm st-vault:qa npm test --workspace @st-vault/server -- src/database/postgres.test.ts
docker run --rm st-vault:qa sh -ec 'npm run build && node scripts/run-browser-tests.mjs sync-request-budget display-clock deletion-intent'
```

Browser fixtures use a separate port, generate synthetic HLS/JPEG data and block external website requests. Output goes to `.local/qa/`; temporary state is cleaned after normal completion. `STV_QA_KEEP_STATE=1` explicitly retains diagnostic state. Never use private databases, cookies or recordings in tests. UI, deletion, media and persistence changes need relevant browser, cancellation, late-response, interruption and restart coverage.

Build before running browser scenarios in the same QA container so the build creates the local workspace dependency links. `sync-request-budget` checks shared deletion reads, fallback and recovery, plus refreshes of rows affected by observation renewals. When diagnosing excess requests, count requests, rows per `/api/workbench` batch and cancellations separately for sign-in, idle, scrolling and media changes.

For source-only iteration, mount the relevant `src` read-only into QA. Do not mount all of apps over the image's workspace dependencies. Rebuild after changing dependencies or build configuration. The compiled business entry point alone does not start the database; production uses `apps/server/src/deploy/start.js` relative to the release root. `STV_BUILD_REVISION` accepts only 40–64 lowercase hexadecimal characters; use the real commit SHA for releases.

After testing the candidate runtime with independent data, local developer deployment uses the override:

```sh
docker compose -f compose.yml -f deploy/compose.build.yml up -d --build
```

[lifecycle.ps1](../tests/deployment/lifecycle.ps1) tests runtime startup and shutdown against the Compose template using disposable volumes.

Existing deployments can keep a read-only root filesystem, writable `/tmp`, and their privilege restrictions. Preserve custom runtime IDs with `STV_RUNTIME_UID` and `STV_RUNTIME_GID`. Adjust `shm_size` within the host's resources if PostgreSQL reports insufficient shared memory.

Keep production data/media, required rollback backups and matching images. Cleanup applies to disposable validation output and Docker resources.

## Verification and release

Pushes to `main` and PRs targeting `main` run CI only. Checks cover formatting, types, tests, builds, the dependency audit and Compose validation. Run browser regression suites locally with the commands above.

1. For a release, update the version in the root and all three workspace `package.json` files and in `package-lock.json`. Add a `## X.Y.Z` entry at the top of the [changelog](CHANGELOG.md) with user-facing notes in both languages and any upgrade instructions. Push `main` and wait for CI to pass.
2. Open [Actions → Publish release](https://github.com/biuzhaoge/st-vault/actions/workflows/dockerhub.yml) on GitHub. Click **Run workflow** and select `main`. The workflow reads the version from the root `package.json` at the selected commit and runs the same CI checks.
3. After both native runners pass the startup, shutdown and database recovery tests, the workflow publishes the `vX.Y.Z` source tag, the `X.Y.Z` multi-platform Docker Hub tag and the GitHub Release with notes. A release of current `main` also updates Docker Hub's `latest` tag and Overview. If `main` advances during the build, users can still pull the versioned tag.

Release tags stay tied to their original source and image. Rerun the original workflow to recover from a failure. Increment the version for new changes after a successful release. The `DOCKERHUB_TOKEN` Actions secret needs permission to push, update the Overview and delete temporary tags. GitHub Actions retains logs for seven days. Images are distributed through [Docker Hub](https://hub.docker.com/r/biuzhaoge/st-vault).

## Legacy upgrades

The current importer supports a one-time PostgreSQL upgrade from a dual-directory SQLite library with manifest format 1 and business metadata format 5. Stop the old application normally and back up complete data, media and the matching image. On first startup, the new image replays acknowledged logs, freezes the source, imports/verifies data and publishes a format-2 checkpoint. Frozen copies are in `data/backups/postgresql-<libraryUUID>/<generation>/`; they do not replace video backups. Allow room for old databases, frozen copies, the new cluster, staging tables and WAL. Avoid repeatedly forcing restarts during a large initial import.

An older single-directory layout must first be converted using [migrate-library.mjs](../scripts/maintenance/migrate-library.mjs) with the matching historical image, not an incompatible current latest. The tool requires a normally closed format-5 source and separate targets outside the source. It hard-links on the same filesystem or copies/verifies across filesystems, supports interrupted reruns and retains the source for rollback.

Old images cannot read the new format or reverse-apply new writes. Cross-format rollback needs both directories from the same stopped-state backup and the matching image, not merely an image switch. Metadata cannot restore already reclaimed video. Password-based installations verify the old password once before setting a PIN; unauthenticated setup is not reopened.

## Performance limits and diagnostics

Use synthetic data from `scripts/benchmarks`, recording CPU/memory limits, storage, sample sizes, warmup and measurement scope. Logs separate pool wait, SQL execution and RPC round-trip time; do not attribute all waiting to SQL. Run the real-network probes in `scripts/diagnostics` explicitly, separate from the default offline tests.

- `capture_polling` reports separate distributions for `admission`, `upstream`, `persist`, `sweep`, `tail` and `rotation`. `p95UpperMs` is a fixed-bucket upper bound. Check the sample count and compare `deadlineLimitedSweeps`, `capacityLimitedSweeps` and `skippedClockRuns` to identify the bottleneck. An upstream request that outlives its logical timeout keeps its original physical slot.
- `workbench_batch_timing` samples cancelled batches and batches taking at least 500 ms, at most once every 10 seconds. Entries include the request window (`spanHours`), buckets per row (`buckets`), row admission, waiter cancellation and drain metrics. Join them to `metadata_rpc_slow`, `database_pool_wait` and `database_query_slow` by request ID to separate RPC, pool wait and SQL. Pool wait and issued statements can still extend drain time.
- The [recording-start benchmark](../scripts/benchmarks/recording-start.mjs) measures a targeted start with a fresh `PUBLIC` observation. `statusCalls` reports whether it actually made an upstream call. The [capture sweep benchmark](../scripts/benchmarks/capture-sweep.mjs) uses 203 synthetic broadcasters and 180 seconds of virtual time to compare acknowledgement gaps, remaining lease time and upstream call counts under mixed request durations, viewer traffic and serial writes.
- The [workbench cost benchmark](../scripts/benchmarks/workbench-cost.mjs) exercises the HTTP route, archive worker and a temporary PostgreSQL instance with empty coverage, dense coverage and seen evidence. It reports RPC counts, worker times and table accesses for coverage and status history. Optional arguments select the sample count and window hours, for example `8 168` for a week. The `list-scroll` browser scenario defaults to a dense week and reports frame intervals, cached detail mounts, and grid paint height. Set `STV_QA_SCROLL_DAYS=1` for a one-day comparison.
- The [mixed recording and playback benchmark](../scripts/benchmarks/recording-workbench.mjs) replays one schedule in two pinned runtime images. The archive receives synthetic fragments from 21 sources and status observations for 194 subjects. Loopback HTTP exercises the workbench, playback, media reads and deletion of synthetic history. The benchmark measures persistence and HTTP handling. Upstream traffic, capture scheduling and browser decoding require separate verification.
- The [screenshot idle benchmark](../scripts/benchmarks/screenshot-idle.mjs) uses 1,000 synthetic subjects and real PostgreSQL. It counts directory, unit-page, statistics and claim queries for 10 seconds after the first rotation. Run `node scripts/benchmarks/screenshot-idle.mjs` after building in the same QA container.

The [runtime performance report](../scripts/diagnostics/runtime-performance.mjs) reads a JSONL slice from stdin. It emits the observed time range, event counts, maximum timings and counts of samples sharing a request ID. Output is limited to known diagnostic fields. Check `input.firstAt` and `input.lastAt` for the observed range. `highestWindowP95UpperMs` is the highest upper bound across the observed windows. Computing a combined P95 requires the original bucket counts.

```sh
docker logs --since 30m --tail 20000 st-vault-app-1 2>&1 | docker run --rm -i --network none --entrypoint node st-vault:qa scripts/diagnostics/runtime-performance.mjs
docker run --rm --network none st-vault:qa sh -ec 'npm run build && node scripts/benchmarks/recording-start.mjs && node scripts/benchmarks/capture-sweep.mjs'
docker run --rm --network none --entrypoint sh st-vault:qa -ec 'npm run build && node scripts/benchmarks/workbench-cost.mjs'
```

For each mixed benchmark arm, mount fresh, empty storage at `/audit-scratch` and mount the script read-only at `/audit/recording-workbench.mjs`. Set `STV_BENCH_SCRATCH=/audit-scratch` and run `node /audit/recording-workbench.mjs 1080`. For generated fMP4, mount the same fixture read-only at `/audit-fixture` and set `STV_BENCH_FIXTURE=/audit-fixture`. The fixture contains `stream.m3u8`, `init.mp4` and `seg<digits>.m4s`. Run the arms serially and record the image SHA, storage type, resource limits and fixture hashes.

Use `--network none`, `--restart no` and an unrotated `json-file` log. Save the live and post-exit stdout and stderr, Docker events and the exit state to a separate evidence directory before removing the container. PostgreSQL writes process roles, SQLSTATE and checkpoint timings to stderr. Compare the offered, completed and dropped counts and latency percentiles in `recording_workbench_trace_complete`. Check the final state of the deletion jobs in `recording_workbench_deletion_results`.

Check the running image for the expected events before collecting. Slow-log thresholds and rate limits apply, so event counts describe the observed sample. Before tuning polling, compare real acknowledgement gaps, lease headroom, upstream errors and write queueing under comparable monitoring and viewer loads. `pollMs` affects both the shared heartbeat and recording status freshness.

Continuous recording, real upstream latency and long-running NAS I/O need separate measurements. Recording prerequisite reads keep their dedicated admission. Measure dense timeline rendering separately for each browser environment.
