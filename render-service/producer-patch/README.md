# Producer resource budgets in OpenMAIC

This directory owns OpenMAIC's source patch for HyperFrames Producer, fixed to
0.8.37 and the commit in `source.json`. The implementation is reviewed and
shipped through OpenMAIC; it does not require a HyperFrames upstream PR or a
published fork. The original Apache-2.0 license is retained in `LICENSE`.

The default service still consumes its existing npm-locked Producer 0.7.107.
The resource path consumes a separately built, private Producer installation.
There is no root-workspace HyperFrames upgrade, automatic installation at
service startup, or silent fallback when the resource path fails.

## Build and input identity

`producer.patch` is the source of truth for the existing admission, native
S/G/W lifecycle, B4 settlement and their owner/installed-package tests.
`source.json` binds the upstream commit, patch digest and every changed file.
`consumer-lock.json` freezes the runtime dependencies, including Linux ARM64
esbuild. Six local workspace tarball integrities are replaced by the actual
build's integrities; third-party versions, resolutions and integrity are kept.

On an existing checkout at the specified HyperFrames commit, this command only
applies the patch in a temporary directory and checks the resulting source:

```sh
node scripts/build-resource-producer.mjs --check /path/to/hyperframes
```

For a provisioned **Linux ARM64** build environment with Node >=22, Bun, Git,
a C compiler and the matching Node headers:

```sh
node scripts/build-resource-producer.mjs --build /path/to/hyperframes /opt/openmaic-resource
```

The output path must not exist. The builder creates its own temporary source
checkout, installs with upstream `bun.lock` frozen, runs the existing six package
builds, and packs the packages with published exports and resolved workspace
versions. It then installs the frozen private npm consumer with lifecycle
scripts disabled and explicitly compiles the native helper on that target.
It reads installed package versions back, checks the consumer lock stayed
unchanged and records native/runtime file hashes in `resource-build.json`.
Build output is retained on failure; the temporary source checkout is removed.

**Download/install scope:** the existing source checkout must already contain the
fixed Git commit; `--check` installs nothing. `--build` installs the upstream
monorepo's frozen build dependencies and this private consumer's frozen runtime
dependencies. It does not install OS packages, download Chromium/FFmpeg, start a
VM/Docker instance, run a render/probe, create cgroups, or change host settings.
The builder is dependency delivery, not an environment provisioning tool. Do not
run it on a host that has not been authorized/provisioned for those builds.

## Service entry

Provision the original cgroup/namespace capabilities and a **fresh, empty,
exclusive** cgroup v2 task delegation before starting the resource path. S must
be outside the task delegation. Service code, private package and configuration
must be root-owned and not writable by the render user. The project root must
already belong to the chosen non-root service/worker UID; the bootstrap does not
recursively chown directories or provision delegation. Memory values must align
to the target kernel page size, and task budgets must fit the owner envelope.

Adapt `resource-config.example.json` to that provisioned environment and save it
as a root-owned file. The example's 1 CPU / 768 MiB task budget is the mechanism
smoke budget, **not a qualified classroom workload profile**.

```sh
npm run start:resources -- /etc/openmaic/resource-config.json
```

This explicit command starts the existing privileged S owner in a separate Node
process, verifies the fixed installed artifact, then drops the HTTP process's
UID/GID and supplementary groups before importing the normal HTTP entry. The
native subreaper/nondumpable settings apply only to S. The default Docker
entrypoint continues to run the normal non-root service; changing an environment
variable does not turn that image into a delegated native deployment. No
privileged Docker option or host cgroup mount is added by this change.

| Existing responsibility | OpenMAIC adaptation | Why it is needed | Verification |
| --- | --- | --- | --- |
| Dedicated S, persistent admission/settlement ledger | `resource-owner.mjs` keeps one existing Producer across requests | A new S per request would lose quarantine and reservation continuity; the HTTP/preview process cannot own process-wide subreaping | Prior fixed Producer evidence; current Linux installed path NOT_RUN |
| Application startup and privilege drop | `resource-main.ts` forks S before dropping the HTTP UID/GID | Loading native in the HTTP process would change unrelated child ownership; running HTTP as root would widen privilege | Source checks; real Linux bootstrap NOT_RUN |
| RenderExecutor cancellation/deadline/result boundary | `ResourceClient` transports requests and replies over inherited IPC | AbortSignals do not cross process boundaries; EOF cannot prove cleanup or reservation return | Client tests for cancellation, owner loss, evidence rejection and bounded transport failure |
| Job/admission/artifact lifecycle | Existing coordinator and job store retain resource settlement and quarantined projects | HTTP terminal state/TTL must not erase uncertain ownership or reopen admission | Coordinator, TTL, queued-rejection and artifact tests |
| Dependency packaging | Fixed source patch and one build entry | The released Producer lacks the resource API and strict-disposal changes | Patch application/hash verification, source-owner tests; full new private build NOT_RUN |

The service queue remains responsible for upload admission, per-user limits and
job ordering. The Producer remains the sole CPU/memory reservation ledger;
OpenMAIC does not infer returned capacity from a completed HTTP job. Its owner
allows one active render with no second hidden queue, matching current service
concurrency. A closed owner makes `/health` report `accepting: false`, rejects new
uploads and rejects already queued jobs before dispatch. Quarantined job records
and their project directories survive TTL cleanup for platform takeover.

The existing local MP4 path is used. Chunk execution is rejected in this mode.
Preview remains on the existing non-root preview path with its existing shared
execution slot and outer deployment limits; this PR does not claim per-task
native budgets for preview. Progress stays at the existing preparing state until
completion because the current budget API has no frame-progress callback; it
does not synthesize percentages or capture metrics. Job records retain complete
settlement/accounting; HTTP polling exposes publication status (including unknown after owner loss) and settlement booleans, not private
filesystem/cgroup paths. Existing ordinary render behavior remains unchanged.

## Validation limits and merge requirements

- The OpenMAIC adapter/coordinator tests use the actual service boundaries with
  a mocked child transport. They are not Linux process/cgroup evidence.
- Historical fixed Linux ARM64 Producer evidence covers normal and major fault
  lifecycles for the previous source candidate. It does not validate the newer
  ancestor-pressure/failure-accounting corrections or this OpenMAIC bootstrap.
- The current new Linux attempt stopped at host memory admission, before any
  download or VM startup. No fresh installed-package PASS is claimed.
- The normal OpenMAIC profile still requires 8 GiB and Chromium 151; low-memory
  still requires 4 GiB. The previous 4 GiB VM / Chromium 145 mechanism smoke
  cannot be represented as this full deployment qualification. Those existing
  profile checks are not relaxed here.
- Before merge: exercise the private build/install readback, native and current
  B4 paths, service bootstrap/privilege boundary, API/S/G deaths, cancellation,
  deadlines and retention through the installed OpenMAIC path; qualify the
  supported deployment profile and run upstream CI. Other architectures and
  resource API execution under Bun are unqualified.

The implementation has no distributed scheduler, persistent queue, reliable
residual-memory estimator or automatic abandoned-owner recovery. Platform
ownership of abandoned sessions and external references remains explicit.
