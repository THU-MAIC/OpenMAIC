# Video Export Benchmark

This is a reproducible benchmark harness for the classroom video-export path.
The corpus is manually constructed and selected to cover different scene counts,
content density, media shapes, and approximately 2, 5, 10, and 20 minute
durations. It contains no external media URLs or learner data.

## Corpus

| Case | Shape | Duration | Scenes | Complexity |
| --- | --- | ---: | ---: | --- |
| `static-deck-2m` | static slides | 120 s | 8 | low |
| `formula-charts-5m` | formulas, tables, SVG charts | 300 s | 10 | medium |
| `image-gallery-10m` | repeated local bitmaps | 600 s | 20 | high |
| `video-elements-5m` | looping video and separate audio | 300 s | 10 | high |
| `webgl-lab-20m` | deterministic WebGL simulation | 1200 s | 8 | high |

`manifest.json` records an input-manifest hash, normalized project hash, and
deterministic ZIP hash for every case. The runner refuses to benchmark a changed
input until the manifest is intentionally updated.

## Commands

Install the render-service dependencies first:

```bash
cd render-service
npm ci
```

Validate all inputs without rendering:

```bash
npm run benchmark:video-export:verify
```

Run three standard 30 fps iterations for every case:

```bash
npm run benchmark:video-export -- --runs 3
```

Useful selectors are `--case static-deck-2m`, `--runs 1`, `--quality draft`,
`--workers 1`, `--output-dir ./benchmark/results/local`, and `--timeout-ms`.
`--print-hashes` prints recalculated hashes for an intentional corpus update.

The command writes `report.json`, one `run.json` per iteration, the exact input
ZIPs, output MP4s, and representative decoded PNGs. `report.json` contains
machine-readable per-run data and nearest-rank P50/P95 summaries. Successful
runs retain producer stage timings, actual capture mode, worker count, frame
count, output size, ffprobe duration and A/V drift, representative frame
comparisons, CPU, RSS, and temporary-disk peaks.

## Container run

The container is the recommended path for resource metrics because cgroup v2
accounts for the Node process, Chromium, and FFmpeg together:

```bash
docker build -f render-service/Dockerfile.benchmark \
  -t openmaic-video-export-benchmark:1 render-service
docker run --rm --cpus=4 --memory=8g \
  -e BENCHMARK_CONTAINER_IMAGE=openmaic-video-export-benchmark:1 \
  -v "$PWD/render-service/benchmark/results:/app/render-service/benchmark/results" \
  openmaic-video-export-benchmark:1 --runs 3
```

The report marks `resources.scope` as `cgroup-v2` in the container. A direct
host run falls back to the runner process and marks the scope as `process`, so
child-browser resource numbers should not be compared across scopes.

The benchmark command is intentionally explicit about capture mode: a missing
producer mode is reported as `unknown`, never silently treated as BeginFrame.
