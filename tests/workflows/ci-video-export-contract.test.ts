import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

interface WorkflowStep {
  name?: string;
  if?: string | boolean;
  run?: string;
  env?: Record<string, string>;
  'continue-on-error'?: boolean | string;
}

interface WorkflowJob {
  if?: string | boolean;
  'continue-on-error'?: boolean | string;
  env?: Record<string, string>;
  steps: WorkflowStep[];
}

interface Workflow {
  jobs: Record<string, WorkflowJob>;
}

const workflowSource = readFileSync(resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
const rootPackage = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
  devDependencies?: Record<string, string>;
};

const EXPECTED_MAIN_PUSH_GATE = `
set -euo pipefail
base="$BEFORE_SHA"
if [ -z "$base" ] || ! git rev-parse --verify --quiet "$base^{commit}" >/dev/null; then
echo "::error::Push range base \${base:-<empty>} is unavailable, so this push cannot be checked."
echo "Re-run after the branch has an ordinary push range, or verify the versions by hand."
exit 1
fi
node scripts/check-package-version-bumps.mjs "$base"
`.trim();

const EXPECTED_HYPERFRAMES_LINT = `
set -euo pipefail
for sample in quiz pbl-v2 pbl-legacy pbl-dense mixed arabic; do
dir="$HF_E2E_DIR/$sample"
if output="$(pnpm exec hyperframes lint "$dir" 2>&1)"; then
status=0
else
status=$?
fi
printf '%s\\n' "$output"
if [ "$status" -ne 0 ]; then
echo "::error::Hyperframes lint failed for $sample (exit $status)."
exit "$status"
fi
if ! grep -Fq -- '0 errors, 0 warnings' <<<"$output"; then
echo "::error::Hyperframes lint for $sample did not report zero errors and zero warnings."
exit 1
fi
done
`.trim();

function parseWorkflow(source = workflowSource): Workflow {
  return load(source) as Workflow;
}

function step(workflow: Workflow, jobName: string, name: string): WorkflowStep {
  const match = workflow.jobs[jobName]?.steps.find((candidate) => candidate.name === name);
  expect(match, `${jobName} must contain "${name}"`).toBeDefined();
  return match!;
}

function normalizeShell(script: string | undefined): string {
  return (script ?? '')
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

function assertMainPushVersionGate(workflow: Workflow): void {
  const mainPush = step(workflow, 'check', 'Package version bumps (main push)');

  expect(mainPush.if).toBe("github.event_name == 'push'");
  expect(mainPush.env).toEqual({ BEFORE_SHA: '${{ github.event.before }}' });
  expect(normalizeShell(mainPush.run)).toBe(EXPECTED_MAIN_PUSH_GATE);
}

const HF_E2E_DIR = '${{ runner.temp }}/openmaic-hyperframes-samples';

function assertHyperframesLintContract(workflow: Workflow): void {
  const lint = step(workflow, 'e2e', 'Lint Hyperframes samples');

  expect(lint.if).toBeUndefined();
  expect(lint['continue-on-error']).toBeUndefined();
  // `runner.*` is only valid in step contexts, not job-level env.
  expect(lint.env).toMatchObject({ HF_E2E_DIR });
  expect(normalizeShell(lint.run)).toBe(EXPECTED_HYPERFRAMES_LINT);
}

function assertHyperframesGateContract(workflow: Workflow): void {
  const job = workflow.jobs.e2e;
  const materialize = step(workflow, 'e2e', 'Materialize Hyperframes lint samples');

  expect(job.if).toBeUndefined();
  expect(job['continue-on-error']).toBeUndefined();
  expect(job.env?.HF_E2E_DIR).toBeUndefined();
  expect(materialize.if).toBeUndefined();
  expect(materialize['continue-on-error']).toBeUndefined();
  expect(materialize.env).toMatchObject({ HF_E2E_DIR });
  expect(materialize.run).toBe('pnpm exec vitest run tests/video-export/e2e-materialize.test.ts');
  assertHyperframesLintContract(workflow);
}

function e2eRenderCommands(workflow: Workflow): string[] {
  const packageOrScriptRunner = /\b(?:pnpm|npm|npx|yarn|node|bun|deno|python(?:3)?|tsx|bash|sh)\b/i;
  const renderEntrypoint =
    /(?:^|[\s"'=:/._-])(?:render|remote[-_:]?render|video[-_:]?render|render[-_:]?video|render[-_:]?service)(?=$|[\s"'=:/._-])/i;
  const networkRenderCall = /\b(?:curl|wget|httpie)\b[^\n]*(?:render|video)/i;
  const hyperframesRender = /\bhyperframes(?:@\S+)?\s+render\b/i;
  const ffmpeg = /\bffmpeg\b/i;
  const directScript = /(?:^|[;&|]\s*)(?:\.{1,2}\/|\/)\S+/i;
  const bareRenderCommand =
    /(?:^|[;&|]\s*)(?:make\s+)?(?:render|remote[-_:]?render|video[-_:]?render|render[-_:]?video|render[-_:]?service)(?=$|\s)/i;

  return workflow.jobs.e2e.steps
    .flatMap((candidate) => (candidate.run ?? '').split('\n'))
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !line.startsWith('#') &&
        (hyperframesRender.test(line) ||
          ffmpeg.test(line) ||
          networkRenderCall.test(line) ||
          bareRenderCommand.test(line) ||
          (directScript.test(line) && renderEntrypoint.test(line)) ||
          (packageOrScriptRunner.test(line) && renderEntrypoint.test(line))),
    );
}

describe('CI video-export workflow contract', () => {
  it('uses the pinned local Hyperframes CLI instead of an ephemeral npx install', () => {
    expect(rootPackage.devDependencies?.hyperframes).toBe('0.7.60');
  });

  it('preserves package version-bump gates for pull requests and main pushes', () => {
    const workflow = parseWorkflow();
    const pullRequest = step(workflow, 'check', 'Package version bumps');

    expect(pullRequest).toMatchObject({
      if: "github.event_name == 'pull_request'",
      run: 'node scripts/check-package-version-bumps.mjs "$BASE_SHA"',
      env: { BASE_SHA: '${{ github.event.pull_request.base.sha }}' },
    });
    assertMainPushVersionGate(workflow);
  });

  it('rejects a main-push gate whose unavailable-base branch no longer exits', () => {
    const mutated = workflowSource.replace(
      'echo "Re-run after the branch has an ordinary push range, or verify the versions by hand."\n            exit 1',
      'echo "Re-run after the branch has an ordinary push range, or verify the versions by hand."\n            : # mutation removes fail-closed exit',
    );

    expect(mutated).not.toBe(workflowSource);
    expect(() => assertMainPushVersionGate(parseWorkflow(mutated))).toThrow();
  });

  it('keeps the forced Chromium cover-card guard required', () => {
    const guard = step(parseWorkflow(), 'e2e', 'Cover-card layout guardrail');

    expect(guard.run).toBe(
      'pnpm exec vitest run tests/video-export/cover-card-layout.browser.test.ts',
    );
    expect(guard.env).toEqual({ COVER_LAYOUT_BROWSER: '1' });
    expect(guard.if).toBeUndefined();
    expect(guard['continue-on-error']).toBeUndefined();
  });

  it('materializes and warning-strict lints the exact six samples with Hyperframes 0.7.60', () => {
    assertHyperframesGateContract(parseWorkflow());
  });

  it.each([
    [
      'materialize step skip',
      (workflow: Workflow) => {
        step(workflow, 'e2e', 'Materialize Hyperframes lint samples').if = false;
      },
    ],
    [
      'materialize step soft failure',
      (workflow: Workflow) => {
        step(workflow, 'e2e', 'Materialize Hyperframes lint samples')['continue-on-error'] = true;
      },
    ],
    [
      'lint step skip',
      (workflow: Workflow) => {
        step(workflow, 'e2e', 'Lint Hyperframes samples').if = false;
      },
    ],
    [
      'lint step soft failure',
      (workflow: Workflow) => {
        step(workflow, 'e2e', 'Lint Hyperframes samples')['continue-on-error'] = true;
      },
    ],
    [
      'e2e job skip',
      (workflow: Workflow) => {
        workflow.jobs.e2e.if = false;
      },
    ],
    [
      'e2e job soft failure',
      (workflow: Workflow) => {
        workflow.jobs.e2e['continue-on-error'] = true;
      },
    ],
  ] satisfies Array<[string, (workflow: Workflow) => void]>)(
    'rejects a non-required Hyperframes gate: %s',
    (_name, mutate) => {
      const mutated = parseWorkflow();
      mutate(mutated);

      expect(() => assertHyperframesGateContract(mutated)).toThrow();
    },
  );

  it.each([
    [
      'extra CLI flags',
      (source: string) =>
        source.replace('hyperframes lint "$dir"', 'hyperframes lint --quiet "$dir"'),
    ],
    ['missing nonzero capture', (source: string) => source.replace('status=$?', 'status=0')],
    ['missing nonzero propagation', (source: string) => source.replace('exit "$status"', 'exit 1')],
    [
      'missing warning-summary failure',
      (source: string) =>
        source.replace(
          'echo "::error::Hyperframes lint for $sample did not report zero errors and zero warnings."\n              exit 1',
          'echo "::error::Hyperframes lint for $sample did not report zero errors and zero warnings."\n              : # mutation removes warning failure',
        ),
    ],
  ])('rejects lint-shell mutation: %s', (_name, mutate) => {
    const mutated = mutate(workflowSource);

    expect(mutated).not.toBe(workflowSource);
    expect(() => assertHyperframesLintContract(parseWorkflow(mutated))).toThrow();
  });

  it('never runs video or remote-render commands in the e2e job', () => {
    expect(e2eRenderCommands(parseWorkflow())).toEqual([]);
  });

  it.each([
    'npx --yes hyperframes@0.7.60 render "$dir"',
    'ffmpeg -i input.mp4 output.mp4',
    'sudo ffmpeg -i input.mp4 output.mp4',
    'curl https://render.example.test/jobs',
    'pnpm remote-render',
    'npm run video-render',
    'npx render-service submit',
    'node scripts/remote-render.mjs',
    'bun scripts/render-video.ts',
    'deno run scripts/video-render.ts',
    'yarn render',
    'python3 scripts/remote_render.py',
    'bash scripts/video-render.sh',
    './scripts/remote-render.mjs',
    'remote-render submit',
    'render-service submit',
    'make remote-render',
  ])('rejects forbidden e2e render command: %s', (command) => {
    const mutated = parseWorkflow();
    mutated.jobs.e2e.steps.push({ name: 'Forbidden mutation', run: command });

    expect(e2eRenderCommands(mutated)).toEqual([command]);
  });
});
