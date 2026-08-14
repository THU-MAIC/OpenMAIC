# @openmaic/render-service

Isolated MP4 render service for OpenMAIC's classroom video export (issue #866).

The main app compiles a classroom to a self-contained Hyperframes project ZIP
(`index.html` + `assets/` + vendored GSAP) entirely in the browser. This service
takes that ZIP and renders it to an MP4 with [`@hyperframes/producer`], which
drives headless Chromium (frame capture) + FFmpeg (encode). It runs in its own
Node 22 container because the producer needs Node ≥ 22, Chromium, and FFmpeg —
none of which belong in the Next.js runtime.

It is an **opt-in capability**: when the app has no `RENDER_SERVICE_URL`
configured, in-app export degrades to downloading the project ZIP for local CLI
rendering. Nothing here is required for the app to run.

## HTTP API

Rendering is asynchronous (a 10-minute video can take tens of minutes): submit,
poll, then download. Job ids are opaque.

| Method + path                 | Purpose                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| `POST /render`                | multipart: `project` (the ZIP) + `fps`, `quality`, `format` fields → `202 { jobId }` |
| `GET /render/:jobId`          | status/progress plus actual capture, worker, profile, and runtime metrics            |
| `GET /render/:jobId/download` | stream the MP4 (or `302` to a presigned URL) once `succeeded`                        |
| `DELETE /render/:jobId`       | cancel a queued/running job                                                          |
| `GET /health`                 | selected resource profile and observed producer/runtime versions                    |

`status` is one of `queued | running | succeeded | failed | cancelled`;
`progress` is `0..1`.

## Environment

| Var                                      | Default                     | Meaning                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                   | `9000`                      | Listen port.                                                                                                                                                                                                                                                                                                                                                        |
| `RENDER_RESOURCE_PROFILE`                | `standard`                  | `standard` requires BeginFrame and 10 GiB; `low-memory` requires screenshot capture and 4 GiB. Both fix one producer worker, one render, and one extraction.                                                                                                                                                                                                          |
| `RENDER_MAX_CONCURRENCY`                 | profile: `1`                | Must match the selected profile. Renders beyond the single execution slot queue FIFO.                                                                                                                                                                                                                                                                               |
| `RENDER_MAX_CONCURRENT_EXTRACTIONS`      | profile: `1`                | Must match the selected profile; bounds archive expansion to one 512 MiB expanded archive at a time.                                                                                                                                                                                                                                                                |
| `RENDER_MAX_JOBS_PER_USER`               | `1`                         | Active jobs allowed per client identity (0 disables the guard — see note below).                                                                                                                                                                                                                                                                                    |
| `RENDER_MAX_QUEUE`                       | `20`                        | Max jobs in the system (reserved+queued+running) before new submits get `429`.                                                                                                                                                                                                                                                                                      |
| `RENDER_JOB_TTL_MS`                      | `1800000`                   | How long finished jobs + artifacts live before cleanup.                                                                                                                                                                                                                                                                                                             |
| `RENDER_JOB_DEADLINE_MS`                 | `2700000`                   | Hard per-job wall-clock deadline; overruns are aborted and marked **failed**.                                                                                                                                                                                                                                                                                       |
| `RENDER_MAX_UPLOAD_BYTES`                | `314572800`                 | Max compressed archive size accepted (300 MB); enforced on real bytes, before buffering.                                                                                                                                                                                                                                                                            |
| `RENDER_MAX_ENTRIES`                     | `5000`                      | Max entries allowed in the archive.                                                                                                                                                                                                                                                                                                                                 |
| `RENDER_MAX_ENTRY_BYTES`                 | `209715200`                 | Max expanded size of any single entry (200 MB).                                                                                                                                                                                                                                                                                                                     |
| `RENDER_MAX_EXPANDED_BYTES`              | `536870912`                 | Max total expanded size across all entries (512 MB).                                                                                                                                                                                                                                                                                                                |
| `RENDER_MAX_COMPRESSION_RATIO`           | `200`                       | Max expanded:compressed ratio per entry (ZIP-bomb guard).                                                                                                                                                                                                                                                                                                           |
| `RENDER_EGRESS_LOCKDOWN`                 | `true`                      | Install the iptables egress lockdown at startup (needs root + `CAP_NET_ADMIN`); **fails closed** — the container exits if the rules can't be applied. Set `false` to run unisolated.                                                                                                                                                                                |
| `PRODUCER_TMP_PROJECT_DIR`               | `/tmp/openmaic-renders`     | Scratch dir for unzipped projects + outputs.                                                                                                                                                                                                                                                                                                                        |
| `PRODUCER_BROWSER_GPU_MODE`              | profile-controlled          | Both profiles use the software/SwiftShader selector; `standard` keeps BeginFrame eligible with `PRODUCER_FORCE_SCREENSHOT=false`, while `low-memory` forces screenshot capture. This is not a host GPU requirement. Do not override it directly.                                                                                                            |
| `PRODUCER_LOW_MEMORY_MODE`               | profile-controlled          | Explicitly `false` for `standard` and `true` for `low-memory`; cgroup heuristics cannot silently switch the selected profile.                                                                                                                                                                                                                                        |
| `PRODUCER_MAX_WORKERS`                   | profile: `1`                | Explicit for both supported profiles so producer auto-sizing cannot raise the worker count.                                                                                                                                                                                                                                                                        |
| `PRODUCER_ENABLE_BROWSER_POOL`           | profile: `false`            | Disabled because both supported profiles use one worker; no additional Chromium instances are admitted.                                                                                                                                                                                                                                                            |
| `PRODUCER_HEADLESS_SHELL_PATH`           | `/usr/bin/chromium-headless-shell` (container) | Chromium **headless shell** executable used by producer's beginFrame resolver. Regular Chromium is not equivalent: it may resolve as beginFrame-capable and then reject `HeadlessExperimental.beginFrame`, causing a screenshot fallback.                                                                                                                                |
| `RENDER_REQUIRE_BEGINFRAME`              | profile-controlled          | `standard` fails the job when producer reports anything except exactly `beginframe`; `low-memory` expects screenshot and does not require BeginFrame.                                                                                                                                                                                                                |
| `PRODUCER_PUPPETEER_PROTOCOL_TIMEOUT_MS` | `900000` (set in Compose)   | CDP timeout headroom for long frame ranges. The producer default of 300 seconds caused long jobs to fall back from four workers to two.                                                                                                                                                                                                                             |
| `HF_STATIC_DEDUP`                        | `false` (set in Compose)    | Temporary OpenMAIC-export workaround: these long slide compositions currently exhaust producer's 15-second verification budget and disable dedup anyway. Skipping the doomed verification removes the fixed startup cost without changing frames.                                                                                                                   |
| `RENDER_HOME`                            | `/app`                      | Writable home used after the entrypoint drops privileges. Producer font caches live under `$RENDER_HOME/.cache`, never `/root/.cache`.                                                                                                                                                                                                                              |
| `PUPPETEER_EXECUTABLE_PATH`              | `/usr/bin/chromium-headless-shell` | System Chromium headless shell (set in the image).                                                                                                                                                                                                                                                                                                                   |

Client identity for the per-user guard is taken from the `x-openmaic-client`
header, which the app's proxy sets. A client-supplied `userId` form field is
ignored. The app derives that header from `x-forwarded-for`/`x-real-ip` **only
when the operator sets `TRUST_PROXY_HEADERS=true`** (and a real reverse proxy
overwrites those headers); otherwise all callers share one `direct` identity, so
the default directly-exposed Compose topology can't be gamed by spoofing
forwarding headers.

> **Per-user guard vs. shared identity.** When identity can't be trusted (no
> reverse proxy → everyone is `direct`), a `RENDER_MAX_JOBS_PER_USER` of 1 would
> throttle the _whole deployment_ to one render at a time. The default Compose
> therefore sets `RENDER_MAX_JOBS_PER_USER=0` (guard off) and relies on
> `RENDER_MAX_CONCURRENCY` + `RENDER_MAX_QUEUE`. Enable the per-user guard only
> behind a trusted proxy that supplies a real per-user identity.

## Security / isolation

The uploaded archive is untrusted, so extraction is bounded _before_ any bytes
are decompressed (entry count, per-entry and total expanded size, and
compression ratio — see the limits above), guarding against ZIP bombs.
Extraction runs on fflate's worker (off the event loop) and is concurrency-capped
so admitted jobs can't stack the per-archive RAM ceiling.

The composition HTML is then executed in headless Chromium. Two boundaries keep
that untrusted page contained:

- **No inbound-to-app bridge.** The container's entrypoint installs an iptables
  egress lockdown (drop all outbound except loopback + replies on app-initiated
  connections), so Chromium can't open connections back to the app — even though
  they share the Compose network so the app can reach the service. This needs the
  container to run with `CAP_NET_ADMIN` (`cap_add: [NET_ADMIN]`, already set in
  the Compose file). With `RENDER_EGRESS_LOCKDOWN=true` (the default) the entrypoint
  **fails closed**: if the rules can't be applied (missing capability, backend
  mismatch) the container exits non-zero rather than start an unisolated service
  the app would still advertise as healthy. An operator who knowingly accepts an
  unisolated standalone setup opts out with `RENDER_EGRESS_LOCKDOWN=false`.
  `scripts/egress-smoke.sh <image>` asserts the boundary end-to-end (lockdown
  active, loopback works, a new outbound connection is blocked).
- **No internet.** In Compose the `render` network is `internal: true` (no host
  or internet gateway). The export ZIP bundles every asset (and GSAP) at build
  time, so the render needs no outbound at all.

**When running standalone, place the service on an isolated network yourself**
(and keep the egress lockdown on, or accept the risk with the toggle) — it needs
no outbound access.

## Run

### Docker (recommended)

The root `docker-compose.yml` wires this service under the `video-export`
profile and points the app at it:

```bash
docker compose --profile video-export up --build
```

### Standalone (development)

Requires Node 22, Chromium's old headless shell, and FFmpeg on `PATH`. The
standard profile checks for 10 GiB of available host/cgroup memory before
listening:

```bash
cd render-service
npm install
PUPPETEER_EXECUTABLE_PATH=$(which chromium-headless-shell) \
PRODUCER_HEADLESS_SHELL_PATH=$(which chromium-headless-shell) \
RENDER_RESOURCE_PROFILE=standard \
PRODUCER_PUPPETEER_PROTOCOL_TIMEOUT_MS=900000 \
HF_STATIC_DEDUP=false \
npm start
```

## Resource profiles

The default `standard` CPU profile is the intended 1080p / 30 fps / standard
quality path: BeginFrame is required, producer workers are fixed at one, and the
service admits one render plus one archive extraction at a time. It requires at
least 10 GiB of host/cgroup memory. A missing headless shell, insufficient
memory, or a producer result whose actual mode is `screenshot`, mixed, or
unknown fails clearly rather than completing under a different capture path.
No host GPU is required or requested; Chromium uses its software/SwiftShader
selector in the standard profile.

Use the safe `low-memory` profile only when BeginFrame latency is less important
than a smaller memory ceiling. It fixes screenshot capture, one worker, one
render, and one extraction, and requires at least 4 GiB:

```bash
RENDER_RESOURCE_PROFILE=low-memory \
RENDER_SERVICE_MEMORY_LIMIT=4g \
docker compose --profile video-export up --build
```

Both `/health` and `GET /render/:jobId` make the selection observable. Health
reports the requested profile, capture mode, worker/concurrency bounds, minimum
memory, and observed Node, producer, Chromium, and FFmpeg versions. A completed
or capture-mode-rejected job reports requested versus actual capture mode and
worker count with the same version record.

The previous fixed 720p short-sample comparison that motivated these profiles was:

| Capture path | Workers | Result |
| --- | ---: | --- |
| screenshot | 1 | 28.7 s baseline |
| BeginFrame | 1 | 16.3 s, about 43% faster |
| BeginFrame | 2 | only a small improvement beyond one worker |
| BeginFrame | 4 | no improvement on four vCPU; higher resource pressure |

These measurements justify the one-worker standard, not a general latency SLA.
The full 1080p sample took 696.9 s with one worker, with capture about 75.5% and
encode about 20.6% of runtime. Four-worker 1080p/4K and multi-job profiles remain
unsupported until their combined correctness and memory bounds are validated.

Output parity must be verified separately for each validated profile before
claiming parity acceptance.

## Scalability

The service is built with three swap points so it can move from a single OSS host
to a horizontally-scaled demo deployment without changing the HTTP contract or
the app:

- **`RenderExecutor`** (`src/render-executor.ts`) — `InProcessExecutor` adapts
  the current HyperFrames producer to stable progress, cancellation, deadline,
  failure, and performance types. A bounded local or remote executor can replace
  it without changing `RenderCoordinator` or the routes.
- **`JobStore`** (`src/job-store.ts`) — Part A ships `InMemoryJobStore`. A
  `RedisJobStore` implementing the same interface lets any replica serve poll /
  download requests.
- **`ArtifactStore`** (`src/artifact-store.ts`) — Part A ships
  `LocalDiskArtifactStore` (streams through the app proxy). An `S3ArtifactStore`
  whose `locate` returns a presigned URL makes the download route `302` the
  browser straight to object storage, bypassing the proxy.

`RenderCoordinator` owns admission, queueing, job state, artifact registration,
and cleanup while depending only on those three interfaces.

Chunked distributed rendering (`@hyperframes/producer/distributed`) to cut
single-job latency is a further, separate follow-up.

[`@hyperframes/producer`]: https://www.npmjs.com/package/@hyperframes/producer
