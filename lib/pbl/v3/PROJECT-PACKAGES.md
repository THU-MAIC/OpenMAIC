# Self-contained PBL v3 project packages

This feature targets `integration/shared-sandbox` and extends its shared
sandbox/workbench (#1964). Package resolution, teaching resources, and registered
evaluation profiles use that branch's existing PBL v3 runner and state machine.

## Archive and compatibility

Ordinary and PBL v1/v2 archives remain `formatVersion: 1`. Runnable PBL v3 exports
use `formatVersion: 2`, requiring `requiredCapabilities: ["pbl-v3-projects@1"]`.
Readers reject unsupported versions/capabilities before writing anything. Older
installations need a reader supporting this capability.

```text
course.maic.zip
├── manifest.json
├── media/...
└── pbl/<content-sha256>/
    ├── project.json
    ├── skeleton/PLAN.md
    ├── skeleton/src/...
    ├── skills/<stage>/SKILL.md
    ├── skills/<stage>/A-teach.md
    ├── docs/...
    ├── tests/...
    └── rubric/...                 # when referenced
```

`manifest.pblProjects` deduplicates projects by content. Each entry contains
`id`, `version`, `checksum`, `root`, `entrypoint: "project.json"`, and a `files`
index mapping relative paths to `{size, sha256}`. Sizes count UTF-8 bytes;
checksums are lowercase hexadecimal SHA-256. The project checksum hashes
canonical JSON of `{id, version, entrypoint, files}`: recursively sorted object
keys, preserved array order, no whitespace. Roots equal `pbl/<checksum>`.

Scenes bind via `projectV3: {id, version, packageId: <checksum>}`. Local asset IDs
never travel in archives. Export reads pinned course templates, including their
Skills/materials and evaluation resources, never learner source changes,
conversations, progress or checkpoints. Standalone HTML exports only briefings
and omits private project resources.

## Authoring a project

For a complete, independently authored minimal course, see
[`examples/pbl/README.md`](../../../examples/pbl/README.md). Running
`node scripts/build-pbl-example.mjs` produces an importable ZIP with one
Python function, bound teaching Skills, a requirement document, and private tests.
It requires no built-in project registration.

`project.json` wraps the existing PBL v3 definition:

```json
{
  "formatVersion": 1,
  "id": "my-python-course",
  "version": "1.0.0",
  "definition": { "id": "my-python-course", "...": "existing project fields" },
  "runtime": {
    "profile": "python3",
    "sourceRoots": ["src"],
    "buildSources": ["src/main.py"],
    "evaluations": { "first-milestone": "tests/first.json" }
  },
  "teaching": [{
    "stage": "first-milestone:0",
    "role": "discussion",
    "entrypoint": "skills/first/SKILL.md",
    "sections": [{ "name": "A-teach.md", "path": "skills/first/A-teach.md" }],
    "documents": ["docs/first.md"]
  }]
}
```

Definition paths select `docs`, `skills`, `skeleton`, `tests`, and `rubric` for
requirements, pedagogy, starters, tests, and rubric. Starters include
`skeleton/PLAN.md`. Every agent stage requires a teaching binding keyed by
`<milestone-id>:<stage-index>` and its role; `intro:-1` binds the retained project
introduction. Section names follow `A-teach.md` style and array order controls
progression. The teaching runner reads the root Skill and active section through
`read_next_skill` with its existing review/new-learner-turn gates. Only bound
documents for that role/stage enter context. Non-guided stages receive their
bound documents and Skill sections directly in the role context. Guided stages
retain the section-by-section `read_next_skill` gates. Role prompt templates can
place context with `{{seed}}`; when omitted, the runtime appends the context so
course materials and stage state still reach the agent. Course Skills never enter the
global/user general-purpose Skill catalog or grant tools or future-stage access.

Built-in Java/Python samples are converted through this same contract during
export. Their virtual requirements/pedagogy paths become `docs`/`skills`. A
receiving installation needs no static registration. Re-export preserves stored
resource bytes instead of reconstructing them from a later built-in definition.

## Runtime profiles and private resources

Version 1 registers `python3` and `java`. The platform generates builds from
`buildSources` (Python AST checks or `javac`); packages cannot supply arbitrary
build shell commands. Evaluation JSON uses the existing adapter:
`{prepare?, cases: [{id, argv, stdout, stdin?}]}`. Python permits `python3`; Java
permits `java`, `javac` and `python3`. Case IDs must be unique. The parent checks
exit status and exact stdout and records the existing evaluation receipts.

Tests, answer keys and rubric files stay outside the learner workspace. The
evaluation runner stages `tests/` and `rubric/` in its temporary directory; argv
can name `{resources}/tests/check.py` and `{resources}/rubric/...`. `{build}`
selects temporary compiled output. Referenced evaluator/rubric/answer-key files
must exist. The registered assessment capability is `exit-code`; there is no
model-based rubric grading in this version. A test script can consume private
rubric or answer-key files. Parent and child share the sandbox identity, so this
remains the existing learning-feedback mechanism.

Import only validates/stores data. It does not start a sandbox or execute code.
Running courses needs deployment-authorized models and an enabled shared sandbox
image with Python 3 (also used by the assessment parent), plus a JDK for Java.
Packages install no toolchains, providers or credentials. Maven/Surefire, external
services and embedded course stages are unsupported in package version 1.

## Persistence, permissions and lifecycle

Validated templates use the existing AssetStore and its configured PostgreSQL
or object storage backend. `pbl_project_installations` records their identities
and hashes; saved scene references become `{id, version, assetId, checksum}`.
The classroom write checks installation, asset ownership and content identity on
the same transaction that publishes scene references. Failures cannot publish
incomplete classrooms. Generic asset replace/delete refuses templates with
`ASSET_IMMUTABLE` (HTTP 409), and general media reads do not expose them to other
authors.

Resolution requires a live classroom owned by the caller and a matching pinned
resource. Identical live or pending imports deduplicate within one owner, including
retries before publication. Pending retries renew the publication TTL. Reimporting
a released template allocates a new pending entry through the normal quota checks,
so collection of the previous entry cannot interrupt publication. Different owners
get separate entries. Different content claiming the same ID/version gets a
separate checksum and never replaces a
previous course. Transfer between authors uses export/import. Learning instances
pin the full reference; changing a scene's content does not silently migrate
its existing learning journey. Use a new scene for that new journey.

Every reload resolves durable bytes without an extraction directory or a
process-local catalog. New workspaces seed missing starter files; existing source
and restored checkpoints retain the existing recovery behavior. The DSL counts
project assets as document references. Same-owner classroom copies add references;
scene/classroom deletion withdraws only their references. Collection preserves
resources referenced by valid classrooms. Failed/unpublished import allocations
expire through the existing pending TTL and collector, with installation index
rows deleted alongside assets. Back up the database/registry and configured byte
store together. Restore missing bytes or re-import the archive after a partial
restore reports unavailable resources.

Version 1 supports UTF-8 text resources only: at most 256 PBL scenes, 16 projects,
512 files and 8 MiB per classroom; 512 KiB per file. Export applies the same
aggregate limits as import, counting each content checksum once. Tests/rubric files
total at most 24 KiB;
starter source snapshots fit the runtime's 256-file / 1 MiB limit;
each evaluation payload is at most 48 KiB. Generated build/evaluation commands must
also fit the sandbox's 32 KiB UTF-8 command limit, including encoded private
resources and the runner itself; import validates this tighter bound.
Unsafe paths, symlinks, extra files,
invalid UTF-8, missing references, checksum/size failures and unsupported profiles
produce errors before publication. No external resource URLs are downloaded.
Correct the archive and retry. If later media/course writes fail, installed
templates remain pending until retry or expiry.

## Verification and live acceptance

```sh
pnpm exec vitest run tests/pbl/v3/project-package.test.ts tests/pbl/v3/project-persistence.test.ts
PBL_PACKAGE_TOOLCHAINS=1 pnpm exec vitest run tests/pbl/v3/project-package.test.ts
PG_CONTRACT_URL=postgres://... pnpm exec vitest run tests/pbl/v3/runtime.pg.test.ts
```

Toolchain checks require `python3`, `java` and `javac` on PATH. The PostgreSQL
suite preserves the integration branch's runtime regression cases and adds
imported Java/Python two-milestone journeys through production teaching tools,
builds and private evaluations. It asserts packaged Skill/material consumption,
pinned resource reload, and no static catalog lookups for imported journeys.
The on-disk persistence fixture closes/reopens its database,
transfers an unregistered course, and checks isolation, immutable assets,
retries, conflicts, copying, deletion and actual collection. Archive fixtures
cover re-export and corrupt input.

These fixtures use controlled model replies and a local sandbox provider. They
are not acceptance against real models/cloud sandboxes. Live acceptance still
requires importing each sample on an installation without its static registration,
completing both milestones with real model/provider configuration, restarting
the application, recovering a checkpoint, and transferring the re-export to a
second clean installation.
