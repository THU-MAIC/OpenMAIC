import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

const repositoryRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

function readManifest(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function fail(headline, problems) {
  console.error([headline, ...problems.map((problem) => `- ${problem}`)].join('\n'));
  process.exit(1);
}

const rootManifest = readManifest(join(repositoryRoot, 'package.json'));
const rootRange = rootManifest.engines?.node;
const rootMinimum = rootRange ? semver.minVersion(rootRange) : null;
if (!rootRange || rootMinimum === null) {
  fail('The root Node engine contract is invalid:', [
    `package.json engines.node must be a valid semver range, got ${JSON.stringify(rootRange)}.`,
  ]);
}

const failures = [];
let constrainedDependencies = 0;

for (const dependency of Object.keys(rootManifest.dependencies ?? {}).sort()) {
  const manifestPath = join(
    repositoryRoot,
    'node_modules',
    ...dependency.split('/'),
    'package.json',
  );
  let manifest;
  try {
    manifest = readManifest(manifestPath);
  } catch (error) {
    failures.push(
      `cannot read installed manifest for ${dependency} at ${manifestPath}: ${String(error)}. ` +
        'Run pnpm install before this check.',
    );
    continue;
  }

  const dependencyRange = manifest.engines?.node;
  if (!dependencyRange) continue;
  constrainedDependencies += 1;
  const dependencyMinimum = semver.minVersion(dependencyRange);
  if (dependencyMinimum === null) {
    failures.push(
      `${dependency} declares an invalid engines.node range: ${JSON.stringify(dependencyRange)}.`,
    );
    continue;
  }
  if (semver.lt(rootMinimum, dependencyMinimum)) {
    failures.push(
      `root engines.node ${JSON.stringify(rootRange)} starts at ${rootMinimum.version}, below ` +
        `${dependency}@${manifest.version} engines.node ${JSON.stringify(dependencyRange)} ` +
        `(minimum ${dependencyMinimum.version}).`,
    );
  }
}

if (failures.length > 0) {
  fail('The root Node engine minimum is below its direct production dependencies:', failures);
}

console.log(
  `Node engine contract passed: root minimum ${rootMinimum.version} satisfies ` +
    `${constrainedDependencies} engine-constrained direct production dependencies.`,
);
