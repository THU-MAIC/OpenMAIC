// Build-time JSON Schema codegen for @openmaic/dsl.
//
// Runs ts-json-schema-generator (a devDependency) over the TS contract and
// emits static dist/schema/*.json for non-TS / bring-your-own-validator
// consumers. The generator is BUILD-ONLY — the package keeps zero runtime deps.
import { createGenerator } from 'ts-json-schema-generator';
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

/** Schema root type -> emitted filename. */
export const ROOTS = {
  Stage: 'stage.schema.json',
  SerializedScene: 'scene.schema.json',
  Action: 'action.schema.json',
};

// Historical stored PBL documents may carry app-owned runtime fields on these
// contract nodes. Keep their TypeScript interfaces precise for consumers, then
// open exactly these JSON Schema definitions for backward-compatible reads.
const OPEN_PBL_DEFINITIONS = ['PBLProject', 'PBLMilestone', 'PBLMicrotask', 'PBLThreadSeat'];

// One generator over the whole tsconfig program, built lazily and reused for
// every root — parses/type-builds the program once instead of per type.
// `createSchema(typeName)` still walks from each root, so each schema only
// carries the definitions reachable from that type.
let generator;
function getGenerator() {
  generator ??= createGenerator({
    tsconfig: resolve(pkgRoot, 'tsconfig.json'),
    skipTypeCheck: true,
    topRef: true,
    // `extended` parses annotation tags — notably `@default`, which carries the
    // canonical static element defaults (see slides.ts / normalize.ts) onto the
    // emitted schema so non-TS consumers ship them too. It is the generator's
    // default; pinned here because the contract now depends on it.
    jsDoc: 'extended',
  });
  return generator;
}

/** Generate the JSON Schema object for one root type (in-memory). */
export function generateSchema(typeName) {
  if (!(typeName in ROOTS)) throw new Error(`unknown schema root: ${typeName}`);
  const schema = getGenerator().createSchema(typeName);
  for (const name of OPEN_PBL_DEFINITIONS) {
    if (schema.definitions?.[name]) schema.definitions[name].additionalProperties = true;
  }
  return schema;
}

function main() {
  const outDir = resolve(pkgRoot, 'dist/schema');
  mkdirSync(outDir, { recursive: true });
  for (const [typeName, out] of Object.entries(ROOTS)) {
    writeFileSync(resolve(outDir, out), JSON.stringify(generateSchema(typeName), null, 2) + '\n');
    console.log(`wrote dist/schema/${out}`);
  }
}

// Run only when invoked directly (`node scripts/gen-schema.mjs`). Compare real
// paths so a symlinked invocation (bin shim, pnpm link) still matches.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) main();
