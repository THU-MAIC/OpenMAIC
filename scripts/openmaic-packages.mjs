import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The one list of owned, publishable @openmaic packages.
 *
 * Several checks and the release workflow each used to carry their own copy of
 * this list, which meant a package missing from one of them was silently exempt
 * from that check rather than failing anything. The scripts now share this
 * module; the workflow cannot import JavaScript into its `on:` trigger, so
 * {@link assertPackageListIsComplete} verifies from the outside that the
 * workflow's own list still agrees with this one.
 *
 * Ordered by dependency: dsl first, since the other three build against it.
 *
 * ── THREAT MODEL FOR EVERY GATE THAT READS THIS ──────────────────────────────
 *
 * This list, and the checks built on it, are configuration held in the same
 * repository as the code they check. Anyone who can merge a change to
 * `scripts/` can also edit the gate itself: shorten this list, relax a rule,
 * delete a workflow step. No amount of additional checking closes that, because
 * every new check arrives with its own editable configuration.
 *
 * That is fine, because it is not the threat these gates are for. They exist to
 * catch MISTAKES — a package added in one place and forgotten in another, a
 * dependency range that publishes differently from how it reads, a test suite
 * that stops running without anyone noticing. Those are silent by default and
 * expensive to find later, which is exactly what a gate is good at. Deliberate
 * subversion is not in scope and cannot be: someone willing to edit these
 * scripts to hide a change can edit the production sources directly, and code
 * review, not tooling, is what stands in the way of that.
 */
export const OPENMAIC_PACKAGES = ['dsl', 'storage', 'renderer', 'importer'];

/** The packages that depend on another owned package, and on which one. */
export const INTERNAL_DEPENDENTS = {
  storage: '@openmaic/dsl',
  renderer: '@openmaic/dsl',
  importer: '@openmaic/dsl',
};

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const PACKAGES_DIRECTORY = join(repositoryRoot, 'packages/@openmaic');

export function packageDirectory(name) {
  return `packages/@openmaic/${name}`;
}

export function readManifest(name) {
  return JSON.parse(readFileSync(join(PACKAGES_DIRECTORY, name, 'package.json'), 'utf8'));
}

const PUBLISH_WORKFLOW = '.github/workflows/publish-packages.yml';

/**
 * Fail if this list has drifted from what actually exists on disk, or from the
 * release workflow's own hardcoded copies.
 *
 * Being wrong in either direction is silent by nature: a package present on
 * disk but missing here is exempt from every check that reads this module, and
 * a package here but missing from the workflow is never published. Both read as
 * a pass unless something asserts otherwise, which is what this does.
 *
 * Returns the problems rather than exiting, so a caller can report them
 * alongside its own.
 */
export function assertPackageListIsComplete() {
  const problems = [];

  const onDisk = readdirSync(PACKAGES_DIRECTORY, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const listed = [...OPENMAIC_PACKAGES].sort();

  for (const name of onDisk) {
    if (!listed.includes(name)) {
      problems.push(
        `packages/@openmaic/${name} exists but is not in OPENMAIC_PACKAGES, so every check ` +
          'that reads this list skips it. Add it there and to publish-packages.yml.',
      );
    }
  }
  for (const name of listed) {
    if (!onDisk.includes(name)) {
      problems.push(`OPENMAIC_PACKAGES lists ${name}, but packages/@openmaic/${name} is gone.`);
    }
  }

  let workflow;
  try {
    workflow = readFileSync(join(repositoryRoot, PUBLISH_WORKFLOW), 'utf8');
  } catch {
    problems.push(`${PUBLISH_WORKFLOW} is missing, so its package list cannot be cross-checked.`);
    return problems;
  }
  problems.push(...crossCheckPublishWorkflow(workflow));

  return problems;
}

/** Compare two name sets and describe the difference from `expected`. */
function describeSetDifference(expected, observed, subject) {
  const problems = [];
  for (const name of expected) {
    if (!observed.includes(name)) {
      problems.push(`${subject} omits ${name}.`);
    }
  }
  for (const name of observed) {
    if (!expected.includes(name)) {
      problems.push(`${subject} names ${name}, which is not in OPENMAIC_PACKAGES.`);
    }
  }
  return problems;
}

/**
 * Check that every place `publish-packages.yml` enumerates packages still names
 * exactly {@link OPENMAIC_PACKAGES}.
 *
 * Textual, because this runs before `pnpm install` and there is no YAML parser
 * on hand. Done honestly rather than by substring search: full-line comments
 * are stripped first, so a commented-out trigger path no longer satisfies the
 * check while quietly disabling a package's release; and each enumeration is
 * compared as a SET, so an unexpected entry fails as well as a missing one.
 *
 * WHAT IT COVERS, and therefore what it does not. Two enumerations are read as
 * exact sets: the `on.push.paths` trigger, and every `for pkg in ...;` loop
 * (the build, pack, publish and tag loops). `--filter "@openmaic/<name>"` is
 * checked more loosely — every package must appear as a filter somewhere, and
 * no filter may name an unknown package — because individual steps legitimately
 * filter subsets, as the typecheck step does by omitting importer. A textual
 * check cannot tell a deliberate subset from an accidental one; converting the
 * workflow to a matrix would, and is a larger change than this.
 */
function crossCheckPublishWorkflow(workflow) {
  const problems = [];
  const source = workflow
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

  // Scoped to the `paths:` list itself. Matching the whole file would also pick
  // up `packages/@openmaic/$pkg/package.json` inside the shell loops, where
  // `$pkg` is the loop variable rather than a package name.
  const pathsBlock = /^\s*paths:\s*$((?:\n\s*-\s*.*)*)/m.exec(source);
  if (!pathsBlock) {
    problems.push(
      `${PUBLISH_WORKFLOW} has no on.push.paths list, so either every push triggers a ` +
        'release or none does; this check expected the trigger to enumerate the packages.',
    );
  } else {
    const triggerPaths = [
      ...pathsBlock[1].matchAll(/packages\/@openmaic\/([^/"'\s]+)\/package\.json/g),
    ].map((match) => match[1]);
    problems.push(
      ...describeSetDifference(
        OPENMAIC_PACKAGES,
        [...new Set(triggerPaths)],
        `${PUBLISH_WORKFLOW} on.push.paths`,
      ),
    );
  }

  const loops = [...source.matchAll(/for pkg in ([^;]+);/g)];
  if (loops.length === 0) {
    problems.push(`${PUBLISH_WORKFLOW} has no \`for pkg in ...\` loop; this check expected one.`);
  }
  for (const loop of loops) {
    const names = loop[1].trim().split(/\s+/).filter(Boolean);
    problems.push(
      ...describeSetDifference(
        OPENMAIC_PACKAGES,
        names,
        `${PUBLISH_WORKFLOW} loop \`for pkg in ${loop[1].trim()}\``,
      ),
    );
  }

  const filtered = new Set(
    [...source.matchAll(/--filter\s+"?@openmaic\/([^"\s]+)"?/g)].map((match) => match[1]),
  );
  for (const name of OPENMAIC_PACKAGES) {
    if (!filtered.has(name)) {
      problems.push(
        `${PUBLISH_WORKFLOW} never passes --filter "@openmaic/${name}", so it is never built ` +
          'or tested on the release path.',
      );
    }
  }
  for (const name of filtered) {
    if (!OPENMAIC_PACKAGES.includes(name)) {
      problems.push(
        `${PUBLISH_WORKFLOW} filters @openmaic/${name}, which is not in OPENMAIC_PACKAGES.`,
      );
    }
  }

  return problems;
}
