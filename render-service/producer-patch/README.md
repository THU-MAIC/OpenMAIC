# Producer resource budgets

OpenMAIC maintains a source patch for HyperFrames Producer 0.8.37, pinned by
`source.json`. It implements CPU/memory admission, per-task native hard limits,
and reservation/artifact settlement. The original upstream license is retained
in `LICENSE`.

This is an experimental, opt-in service path. The default service retains its
npm-locked Producer 0.7.107 and existing privilege model. **The resource
path requires installed Linux qualification for the deployment target.**

## Build

Provision Linux ARM64 or x86_64 with Node >=22, Bun, Git, a C compiler and
matching Node headers. The source checkout must be at `source.json.revision`.

From `render-service`:

```sh
# Applies and verifies the patch in a temporary directory; installs nothing.
node scripts/build-resource-producer.mjs --check /path/to/hyperframes

# Reuses provisioned FFmpeg during the upstream dependency install.
FFMPEG_BIN=/usr/bin/ffmpeg node scripts/build-resource-producer.mjs \
  --build /path/to/hyperframes /opt/openmaic-resource
```

The output directory must not exist. The builder uses upstream `bun.lock`,
builds six workspace packages and installs the private consumer from
`consumer-lock.json`. Only the six rebuilt local tarball integrities change;
third-party versions and integrity remain fixed. It explicitly compiles native
helpers and records the installed package, lock and file identities in
`resource-build.json`. Failed build output is retained; the temporary checkout
is removed.

An extracted fixed-commit archive can be used with `--check-archive` or
`--build-archive` instead. `upstream.commit` binds the original commit object;
the complete extracted Git tree must match, including file modes and symlinks.
Supply a safely extracted, immutable directory without `.git` metadata.
The builder does not download or extract the archive.

`producer.patch` contains the implementation and its tests. `source.json`
binds the patch and changed-file hashes. Build commands do not provision OS
packages, Chromium, cgroups or a VM, and do not run product tests. Set
`FFMPEG_BIN` to an existing executable to prevent the upstream `ffmpeg-static`
install script from downloading another binary.

## Startup and ownership

Provision an exclusive, empty cgroup v2 task delegation with CPU/memory
and pids controllers, `cgroup.kill`, `memory.events.local`, and the privileges needed for
`CLONE_INTO_CGROUP` and mount/cgroup namespaces. The supervisor must run outside
the task delegation. Code, package and configuration paths must be root-owned
and immutable to the render user; the project root must belong to the configured
non-root worker UID/GID.

The configuration file and every parent directory must be root-owned, not
writable by group/others, and free of symlinks. Both privileged readers enforce
this before reading; root-controlled configuration updates are trusted.
`PRODUCER_TMP_PROJECT_DIR` must name an existing absolute directory without symlink
components; its normalized path must equal `projectRoot`. Equivalent trailing
slashes and `..` spelling are allowed. Invalid roots fail before the service starts.

Adapt `resource-config.example.json` and save it as a root-owned configuration:

```sh
npm run start:resources -- /etc/openmaic/resource-config.json
```

The bootstrap starts a separate privileged supervisor, verifies the installed
package, then drops the HTTP process's UID/GID and supplementary groups.
Native subreaper/nondumpable settings apply only to the supervisor. Memory
budgets must be page-aligned and fit the owner envelope. The example's
1 CPU / 768 MiB budget is a mechanism-test setting, not a qualified classroom
workload profile.

`owner.taskPidsMax` is a required positive integer (256 in the example), applied
and read back as each attempt's `pids.max` before its first process starts.
Missing pids delegation or a failed readback rejects startup. It bounds processes
and threads; it does not add a PID dimension to the CPU/memory admission ledger.
The deployment must reserve PID headroom for S/G and HTTP in their separate
control domain, including under any shared ancestor PID limit. The example
ceiling still needs qualification with the exact installed package.

Only the supervised worker retains temporary paths until guardian cleanup.
Producer/Engine disposal retires entries by rename, including retry paths;
atomic file replacement retains the previous inode, and Chrome profiles are
explicitly task-owned. Supervised frame copies use separate inodes, so retained
internal cache links are not mistaken for unknown links. After W and descendants drain, the existing guardian
checks references and removes private objects. Unknown links or deletion failure
detected at this pre-publication stage block publication, retain the reservation
and close admission. Retained temporary
data remains charged to the task until that cleanup; no extra memory or deadline
is granted. This does not prove absence of external open FDs, mappings or service
references; the documented exclusive ownership boundary still applies.

Publication and reservation return are separate outcomes. If the final transaction
directory cannot be removed after the artifact has been committed, the published
artifact remains available, the reservation stays quarantined and admission
closes. Platform cleanup is required; this is not a guarantee that every cleanup
failure prevents publication.

| Component | Responsibility and reason for separation | Verification |
| --- | --- | --- |
| `resource-owner.mjs` | Keeps one Producer and reservation ledger across requests; process-wide subreaping must stay outside HTTP | Owner tests and installed supervisor/death cases |
| `resource-main.ts` | Starts the supervisor before dropping HTTP privileges | Installed bootstrap and privilege checks |
| `ResourceClient` | Carries cancellation, deadlines and settlement over IPC; lost transport cannot prove cleanup | Client tests and installed cancellation/owner-loss cases |
| Existing coordinator/job store | Rejects work when admission closes and retains quarantined projects across TTL cleanup | Settlement tests and installed fault cases |
| Fixed patch/build entry | Supplies the resource API absent from the default released dependency | Source/package tests and installed build readback |

Producer is the sole CPU/memory reservation ledger. The service retains upload
admission, per-user limits and job ordering, with one active render and no
second hidden queue. HTTP completion alone does not return a reservation.
A closed owner closes admission and rejects queued jobs; quarantined records
and projects remain available for platform takeover.

Owner stderr is inherited by the service log stream, including diagnostics emitted
after IPC disconnect. Public task errors use stable summaries rather than internal
exception text; consult service logs for the original error.

An unexpected Producer exception without verified settlement also closes service
admission, even if the Producer has not reported itself closed. This deliberately
preserves uncertainty; it does not prove that cleanup or reservation return
succeeded. Automatic reopening is not supported. Before restarting, the operator
must stop the old service, verify its processes and task descendants have exited,
and reconcile retained task domains, projects and external references. Reuse the
delegation only after verified cleanup, or provision a fresh isolated delegation
and project root while retaining ownership of the old resources. Restart alone
does not establish safe reclamation.

## Supported boundary

- The resource path uses local MP4 rendering; chunk execution is rejected.
- Preview retains its existing execution path and outer limits. Per-task native
  budgets for preview are not claimed.
- Progress remains at preparing until completion; frame percentages and capture
  metrics are not synthesized.
- Job records retain accounting. HTTP exposes publication/settlement status,
  including unknown publication after owner loss, without private paths.
- Default service and Docker startup do not enable privileged resource execution.
- Platform ownership of abandoned sessions and external references is required;
  automatic recovery, persistent queues and distributed scheduling are outside
  this implementation.

See [Linux validation](LINUX-VALIDATION.md) for required installed-package and
service lifecycle checks. Portable tests and historical Producer runs do not
qualify the current installation. Supported architecture/profile evidence and
final CI must accompany the exact candidate before merge.
