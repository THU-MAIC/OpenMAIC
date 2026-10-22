import 'server-only';
import { sandboxConflict } from '@/lib/sandbox/errors';
import type { EvaluationResult } from '@/lib/pbl/v3/domain/orchestration/types';
import type { SandboxCommandResult } from '@/lib/sandbox/types';
import type { InstalledProject } from './catalog';

export interface ProjectEvaluation {
  /** Private course resources, staged only in the evaluation's temporary directory. */
  resources?: Record<string, string>;
  /** Deployment-owned argv, not user-provided shell text. */
  prepare?: string[];
  /** id/label are learner-visible metadata; keep private test details in argv/stdout. */
  cases: { id: string; label?: string; argv: string[]; stdout: string; stdin?: string }[];
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export function evaluationFor(project: InstalledProject, milestone: string) {
  const spec = project.evaluations[milestone];
  if (!spec?.cases.length) throw sandboxConflict('No evaluation is installed for this milestone.');
  if (!project.coursePackage) return spec;
  const resources = Object.fromEntries(
    Object.entries(project.coursePackage.bundle.files).filter(([path]) =>
      /^(tests|rubric)\//.test(path),
    ),
  );
  return { ...spec, resources };
}
/** The parent checks actual child output. A learner process exiting zero before executing a check cannot pass.
 * This is learning feedback, not a hostile-code grading boundary: parent and child share the sandbox identity.
 */
export function evaluationCommand(spec: ProjectEvaluation, requestId: string) {
  const payload = Buffer.from(JSON.stringify({ spec, requestId })).toString('base64');
  const script = `import base64,json,subprocess,tempfile,os
cfg=json.loads(base64.b64decode(${JSON.stringify(payload)}))
spec=cfg['spec']; results=[]; build=True; buildReason=None
with tempfile.TemporaryDirectory(prefix='pbl-check-') as out:
 resources=os.path.join(out,'evaluation'); os.makedirs(resources)
 for path,text in spec.get('resources',{}).items():
  target=os.path.join(resources,path); os.makedirs(os.path.dirname(target),exist_ok=True)
  with open(target,'w',encoding='utf-8') as f: f.write(text)
 def run(argv,stdin=''):
  return subprocess.run([a.replace('{build}',out).replace('{resources}',resources) for a in argv],input=stdin,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=15)
 try:
  if spec.get('prepare'):
   build=run(spec['prepare']).returncode==0
   if not build: buildReason='build'
  for case in spec['cases']:
   passed=False; reason='not_run'
   if build:
    try:
     proc=run(case['argv'],case.get('stdin',''))
     passed=proc.returncode==0 and proc.stdout==case['stdout']
     reason=None if passed else ('execution' if proc.returncode else 'output')
    except subprocess.TimeoutExpired: reason='timeout'
    except OSError: reason='environment'
   results.append({'id':case['id'],'passed':passed,'reason':reason})
 except subprocess.TimeoutExpired: build=False; buildReason='timeout'
 except OSError: build=False; buildReason='environment'
print(str(sum(r['passed'] for r in results))+' / '+str(len(spec['cases']))+' checks passed')
if not build: print('Build failed or could not complete. Run the build check for diagnostics.')
for r in results: print(r['id']+(': passed' if r['passed'] else ': did not satisfy the project contract'))
print('PBL_RESULT:'+cfg['requestId']+':'+json.dumps({'build':build,'buildReason':buildReason,'checks':results},separators=(',',':')))
`;
  return `python3 -c ${quote(script)}`;
}
type Receipt = {
  build: boolean;
  buildReason?: 'build' | 'timeout' | 'environment';
  checks: NonNullable<NonNullable<EvaluationResult['publicDiagnostics']>['caseResults']>;
};

/** Only the installed case identities and a complete run-specific receipt establish evidence. */
function evaluationReceipt(spec: ProjectEvaluation, id: string, output: string): Receipt | null {
  const prefix = `PBL_RESULT:${id}:`;
  const lines = output.split('\n').filter((line) => line.startsWith(prefix));
  if (lines.length !== 1) return null;
  try {
    const value = JSON.parse(lines[0]!.slice(prefix.length));
    if (
      typeof value.build !== 'boolean' ||
      !Array.isArray(value.checks) ||
      value.checks.length !== spec.cases.length ||
      (value.buildReason != null &&
        !['build', 'timeout', 'environment'].includes(value.buildReason))
    )
      return null;
    const reasons = ['output', 'execution', 'timeout', 'environment', 'not_run'];
    const checks: Receipt['checks'] = spec.cases.map((c, index) => {
      const result = value.checks[index];
      if (
        result?.id !== c.id ||
        typeof result.passed !== 'boolean' ||
        (result.passed && (result.reason != null || value.build === false)) ||
        (result.reason != null && !reasons.includes(result.reason))
      )
        throw new Error('Invalid case receipt');
      return {
        id: c.id,
        label: (c.label ?? c.id).slice(0, 160),
        passed: result.passed,
        ...(!result.passed && result.reason ? { reason: result.reason } : {}),
      };
    });
    return { build: value.build, buildReason: value.buildReason ?? undefined, checks };
  } catch {
    return null;
  }
}
export function evaluationPassed(spec: ProjectEvaluation, id: string, output: string): boolean {
  const receipt = evaluationReceipt(spec, id, output);
  return receipt?.build === true && receipt.checks.every((c) => c.passed);
}

/** Match OpenPBL's public-diagnostics boundary without its Maven-specific runtime. */
export function evaluationOutcome(
  spec: ProjectEvaluation,
  id: string,
  observed: Pick<SandboxCommandResult, 'state' | 'exitCode' | 'stdout' | 'stderr'>,
): Pick<EvaluationResult, 'status' | 'failureKind' | 'publicFeedback' | 'publicDiagnostics'> {
  const receipt =
    observed.state === 'exited' && observed.exitCode === 0
      ? evaluationReceipt(spec, id, observed.stdout)
      : null;
  if (
    !receipt ||
    receipt.buildReason === 'environment' ||
    receipt.buildReason === 'timeout' ||
    receipt.checks.some((c) => c.reason === 'environment')
  )
    return {
      status: 'error',
      failureKind: 'infrastructure',
      publicFeedback:
        'The evaluation could not produce a reliable result. Check the project environment and rerun.',
      publicDiagnostics: {
        kind: 'infrastructure',
        summary: 'No reliable test verdict is available; this is not a confirmed code failure.',
        reportGenerated: false,
      },
    };
  const checks = receipt.checks;
  const passed = receipt.build && checks.every((c) => c.passed);
  const kind = !receipt.build
    ? 'compile'
    : checks.some((c) => c.reason === 'timeout')
      ? 'timeout'
      : 'assertion';
  const reasons = {
    output: 'output did not satisfy the contract',
    execution: 'code could not execute successfully',
    timeout: 'check timed out',
    environment: 'test environment unavailable',
    not_run: 'not run because the build failed',
  };
  const feedback = [
    `${checks.filter((c) => c.passed).length} / ${checks.length} checks passed`,
    ...checks.map((c) => `${c.label}: ${c.passed ? 'passed' : reasons[c.reason ?? 'output']}`),
  ]
    .join('\n')
    .slice(0, 8000);
  return {
    status: passed ? 'passed' : 'failed',
    ...(passed ? {} : { failureKind: kind }),
    publicFeedback: feedback,
    publicDiagnostics: {
      kind,
      summary: passed
        ? 'All installed checks passed.'
        : !receipt.build
          ? 'The code build failed before tests could run.'
          : 'Some checks did not satisfy the project contract.',
      reportGenerated: receipt.build,
      caseResults: checks,
    },
  };
}
