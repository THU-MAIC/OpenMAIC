import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import { expect, it } from 'vitest';

interface Workflow {
  jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
}

it('runs every tracked app PostgreSQL suite in the database-backed CI step', () => {
  const root = process.cwd();
  const workflow = load(
    readFileSync(resolve(root, '.github/workflows/storage-pg-contract.yml'), 'utf8'),
  ) as Workflow;
  const step = workflow.jobs['storage-pg-contract'].steps.find(
    (candidate) => candidate.name === 'App-domain PostgreSQL contracts',
  );
  expect(step?.run, 'The app PostgreSQL contract step must run its suites').toBeDefined();

  const command = step!
    .run!.replace(/\\\r?\n/g, ' ')
    .trim()
    .split(/\s+/);
  expect(command.slice(0, 4)).toEqual(['pnpm', 'exec', 'vitest', 'run']);

  const suites = execFileSync('git', ['ls-files', '-z', '--', 'tests/**/*.pg.test.ts'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
    .sort();
  expect(suites.length).toBeGreaterThan(0);
  expect(command.slice(4).sort()).toEqual(suites);
});
