import {
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const source = resolve(projectRoot, '.next/standalone');
const target = resolve(projectRoot, 'dist/desktop-runtime');

rmSync(target, { recursive: true, force: true });
mkdirSync(resolve(projectRoot, 'dist'), { recursive: true });
const generatedDist = resolve(source, 'dist');
cpSync(source, target, {
  recursive: true,
  dereference: true,
  filter: (entry) => {
    if (entry === generatedDist || entry.startsWith(`${generatedDist}/`)) return false;
    try {
      if (lstatSync(entry).isSymbolicLink()) {
        try {
          realpathSync(entry);
        } catch {
          // pnpm can leave optional hoist links dangling in standalone output.
          return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  },
});

// electron-builder intentionally filters directories named node_modules from
// extraResources. Keep the standalone dependency tree under a neutral name;
// desktop/main.cjs adds it to NODE_PATH before launching server.js.
renameSync(resolve(target, 'node_modules'), resolve(target, 'runtime-modules'));

// pnpm keeps the standalone hoist table under `.pnpm/node_modules`. Since the
// packaged server uses NODE_PATH instead of a directory literally named
// `node_modules`, recreate those hoisted entries at the runtime root while
// preserving relative links inside the staged tree.
const runtimeModules = resolve(target, 'runtime-modules');
const swcPackage = readdirSync(resolve(runtimeModules, '.pnpm')).find((entry) =>
  entry.startsWith('@swc+helpers@'),
);
if (swcPackage) {
  mkdirSync(resolve(runtimeModules, '@swc'), { recursive: true });
  cpSync(
    resolve(runtimeModules, '.pnpm', swcPackage, 'node_modules', '@swc', 'helpers'),
    resolve(runtimeModules, '@swc', 'helpers'),
    { recursive: true, dereference: true },
  );
}

console.log(`[desktop-runtime] staged standalone server at ${target}`);
