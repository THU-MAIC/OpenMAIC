import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

interface WorkflowStep {
  id?: string;
  name?: string;
  run?: string;
  env?: Record<string, string>;
}

interface WorkflowJob {
  needs?: string | string[];
  outputs?: Record<string, string>;
  steps: WorkflowStep[];
}

interface Workflow {
  jobs: Record<string, WorkflowJob>;
}

const workflowSource = readFileSync(
  resolve(process.cwd(), '.github/workflows/publish-packages.yml'),
  'utf8',
);

function parseWorkflow(source = workflowSource): Workflow {
  return load(source) as Workflow;
}

function step(workflow: Workflow, jobName: string, name: string): WorkflowStep {
  const match = workflow.jobs[jobName]?.steps.find((candidate) => candidate.name === name);
  expect(match, `${jobName} must contain "${name}"`).toBeDefined();
  return match!;
}

function assertPublishedVersionHandoff(workflow: Workflow): void {
  const publish = workflow.jobs.publish;
  const publishStep = step(
    workflow,
    'publish',
    'Registry preflight and publish validated tarballs',
  );
  const mark = workflow.jobs.mark;
  const markStep = step(workflow, 'mark', 'Write missing release markers');

  expect(publish.outputs).toEqual({
    published_versions: '${{ steps.publish.outputs.published_versions }}',
  });
  expect(publishStep.id).toBe('publish');
  expect(publishStep.run).toContain('published_versions=""');
  expect(publishStep.run).toContain(
    'published_versions="${published_versions:+$published_versions,}$name@$version"',
  );
  expect(publishStep.run).toContain(
    'printf \'published_versions=%s\\n\' "$published_versions" >> "$GITHUB_OUTPUT"',
  );

  expect(mark.needs).toBe('publish');
  expect(markStep.env).toMatchObject({
    PUBLISHED_VERSIONS: '${{ needs.publish.outputs.published_versions }}',
  });
  expect(markStep.run).toContain('if [[ ",$PUBLISHED_VERSIONS," == *",$tag,"* ]]; then');
  expect(markStep.run).toContain(
    'Published $tag in this run; registry propagation is not required.',
  );
  expect(markStep.run).toContain(
    'elif ! npm view "$name@$version" version --registry https://registry.npmjs.org >/dev/null 2>&1; then',
  );
}

describe('publish-package marker workflow contract', () => {
  it('hands exact successful publishes to the marker job without losing reconciliation', () => {
    assertPublishedVersionHandoff(parseWorkflow());
  });

  it.each([
    [
      'drops the publish output',
      (source: string) =>
        source.replace(
          'published_versions: ${{ steps.publish.outputs.published_versions }}',
          'published_versions: ""',
        ),
    ],
    [
      'reintroduces the registry race for current publishes',
      (source: string) =>
        source.replace('if [[ ",$PUBLISHED_VERSIONS," == *",$tag,"* ]]; then', 'if false; then'),
    ],
    [
      'drops registry reconciliation for older releases',
      (source: string) =>
        source.replace(
          'elif ! npm view "$name@$version" version --registry https://registry.npmjs.org >/dev/null 2>&1; then',
          'elif false; then',
        ),
    ],
  ])('rejects a broken handoff that %s', (_name, mutate) => {
    const mutated = mutate(workflowSource);
    expect(mutated).not.toBe(workflowSource);
    expect(() => assertPublishedVersionHandoff(parseWorkflow(mutated))).toThrow();
  });
});
