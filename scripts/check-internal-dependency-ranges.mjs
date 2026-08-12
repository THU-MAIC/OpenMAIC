import {
  INTERNAL_DEPENDENTS,
  OPENMAIC_PACKAGES,
  assertPackageListIsComplete,
  readManifest,
} from './openmaic-packages.mjs';

/**
 * An owned @openmaic package may be declared as a dependency of another exactly
 * once, in `dependencies`, as `workspace:^`.
 *
 * WHY `workspace:^`. pnpm publishes `workspace:*` as an EXACT pin, so a
 * consumer installing two dependents that were released at different times gets
 * two copies of `@openmaic/dsl`. The dsl carries the schema, the validators and
 * the version constants, so two copies mean a document produced against one
 * instance can be validated by the other instance's schema revision.
 * `workspace:^` publishes as `^<version>` and lets one copy satisfy both.
 *
 * WHY "EXACTLY ONCE, IN `dependencies`". A caret in `dependencies` does not
 * help if a second, tighter constraint on the same package is published
 * alongside it. `peerDependencies` and `optionalDependencies` are both real
 * published constraints that a package manager will enforce, so an exact entry
 * in either reintroduces the duplicate this check exists to prevent while
 * `dependencies` still reads correctly. They are rejected outright: nothing in
 * this family has a reason to declare a sibling as a peer or an optional, and
 * making that a decision someone has to argue for is cheaper than trying to
 * validate the combination.
 *
 * WHERE THIS RUNS. `scripts/smoke-test-package-tarballs.mjs` proves the same
 * thing about the tarball that would actually be published, which is the
 * stronger claim — but it installs four package tarballs, so it runs only on
 * the release path. This is the cheap source-level form, in `ci.yml`, so that a
 * pull request reintroducing an exact pin fails at review time rather than at
 * release time, after a version number has already been spent.
 *
 * KNOWN LIMITATION, deliberately accepted: `^` deduplicates within one 0.x line
 * only. A consumer mixing a dependent that requires `^0.5.0` with one that
 * requires `^0.6.0` still installs two dsl lines. Closing that would mean
 * making the dsl a peer dependency of its dependents, which changes their
 * public installation contract and is out of scope here. What keeps the caret
 * meaningful in the meantime is the rule in `check-package-version-bumps.mjs`
 * that a serialized-format change must cross the dependents' caret boundary.
 */

const OWNED = new Set(OPENMAIC_PACKAGES.map((name) => `@openmaic/${name}`));

/** Published constraint fields in which an owned package must never appear. */
const FORBIDDEN_FIELDS = ['peerDependencies', 'optionalDependencies'];

function report(headline, problems) {
  console.error([headline, ...problems.map((problem) => `- ${problem}`)].join('\n'));
  process.exit(1);
}

// Checked first and fatally: every check below reads this list, so if the list
// itself is wrong there is nothing meaningful to say about what it contains.
const listProblems = assertPackageListIsComplete();
if (listProblems.length > 0) {
  report('The shared @openmaic package list has drifted:', listProblems);
}

const failures = [];
/** package name -> every owned dependency it declares in `dependencies`. */
const seen = new Map();

for (const name of OPENMAIC_PACKAGES) {
  const manifest = readManifest(name);

  for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
    if (!OWNED.has(dependency)) continue;
    // Collected as a list, not a single value: overwriting would hide a second
    // owned dependency behind whichever happened to be declared last.
    seen.set(name, [...(seen.get(name) ?? []), dependency]);
    if (range === 'workspace:^') {
      console.log(`@openmaic/${name}: dependencies.${dependency} = ${range}`);
      continue;
    }
    failures.push(
      `@openmaic/${name} declares dependencies."${dependency}" as ${JSON.stringify(range)}. ` +
        'Use "workspace:^": the "workspace:*" form publishes as an exact pin, which forces ' +
        'consumers to install a second copy of that package alongside its siblings.',
    );
  }

  for (const field of FORBIDDEN_FIELDS) {
    for (const dependency of Object.keys(manifest[field] ?? {})) {
      if (!OWNED.has(dependency)) continue;
      failures.push(
        `@openmaic/${name} declares ${field}."${dependency}". An owned @openmaic package may ` +
          'be declared exactly once, in `dependencies`. A second published constraint here ' +
          'can pin the same package exactly while `dependencies` still reads as a caret, ' +
          'which reintroduces the duplicate copy this check exists to prevent.',
      );
    }
  }
}

// Cross-checked in BOTH directions. Checking only that each mapped dependent
// still declares its dependencies leaves the map itself unguarded: delete an
// entry and that package is exempt from this check and from the packed-manifest
// assertion, which iterates the same map. Moving a declaration to
// `devDependencies` would then let it publish without the required constraint.
for (const [name, expected] of Object.entries(INTERNAL_DEPENDENTS)) {
  const expectedDependencies = [...expected].sort();
  const observed = seen.get(name);
  if (observed === undefined) {
    failures.push(
      `@openmaic/${name} no longer declares any owned @openmaic dependency in \`dependencies\`; ` +
        `it was expected to depend on ${expectedDependencies.join(', ')}. If that is intended, update ` +
        'INTERNAL_DEPENDENTS in scripts/openmaic-packages.mjs — this check must not go quiet ' +
        'on its own.',
    );
    continue;
  }
  const observedDependencies = [...observed].sort();
  if (
    observedDependencies.length !== expectedDependencies.length ||
    observedDependencies.some((dependency, index) => dependency !== expectedDependencies[index])
  ) {
    failures.push(
      `@openmaic/${name} declares owned dependencies (${observedDependencies.join(', ')}), but ` +
        `INTERNAL_DEPENDENTS expects (${expectedDependencies.join(', ')}).`,
    );
  }
}

for (const [name, observed] of seen) {
  if (name in INTERNAL_DEPENDENTS) continue;
  failures.push(
    `@openmaic/${name} declares the owned dependency ${observed.join(', ')} but is absent from ` +
      'INTERNAL_DEPENDENTS in scripts/openmaic-packages.mjs, so nothing checks how it is ' +
      'published. Add it there.',
  );
}

// devDependencies last, and rejected outright rather than range-checked. An
// owned package listed there is a second declaration of a sibling that no
// consumer resolves, which is precisely how a dependent could stop declaring
// its dsl dependency while still building and testing against it.
for (const name of OPENMAIC_PACKAGES) {
  for (const dependency of Object.keys(readManifest(name).devDependencies ?? {})) {
    if (!OWNED.has(dependency)) continue;
    failures.push(
      `@openmaic/${name} declares devDependencies."${dependency}". An owned @openmaic package ` +
        'belongs in `dependencies` and nowhere else: a devDependency is not published as a ' +
        'constraint, so it would satisfy the workspace link while the tarball declared no ' +
        'dependency on it at all.',
    );
  }
}

if (failures.length > 0) {
  report('Internal @openmaic dependency declarations are not in the required shape:', failures);
}

console.log(
  `Internal dependency check passed: ${Object.keys(INTERNAL_DEPENDENTS).length} expected ` +
    'dependents declare each owned dependency exactly once, in `dependencies`, as workspace:^.',
);
