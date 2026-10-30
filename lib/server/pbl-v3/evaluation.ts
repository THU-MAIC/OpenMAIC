import 'server-only';
import { createHash } from 'node:crypto';
import { sandboxConflict } from '@/lib/sandbox/errors';
import type {
  EvaluationResult,
  PublicEvaluationDiagnosticLocation,
} from '@/lib/pbl/v3/domain/orchestration/types';
import type { SandboxCommandResult } from '@/lib/sandbox/types';
import type { InstalledProject } from './catalog';
import { additionalBuildSources } from './build-command';

export interface ProjectEvaluation {
  /** Private course resources, staged only in the evaluation's temporary directory. */
  resources?: Record<string, string>;
  /** Deployment-owned argv, not user-provided shell text. */
  prepare?: string[];
  /** Expected stdout stays on the host; it is never part of the execution payload. */
  cases: { id: string; label?: string; argv: string[]; stdout: string; stdin?: string }[];
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export function evaluationFor(
  project: InstalledProject,
  milestone: string,
  paths: readonly string[] = [],
) {
  const installed = project.evaluations[milestone];
  if (!installed?.cases.length)
    throw sandboxConflict('No evaluation is installed for this milestone.');
  const added = additionalBuildSources(project, paths, '.java');
  const compile = (argv: string[]) =>
    argv[0] === 'javac' &&
    added.length &&
    argv.some(
      (arg) => Object.hasOwn(project.files, arg.replace(/^\.\//, '')) && arg.endsWith('.java'),
    )
      ? [
          ...argv,
          ...added
            .filter((path) => !argv.includes(path) && !argv.includes(`./${path}`))
            .map((path) => `./${path}`),
        ]
      : argv;
  const spec = {
    ...installed,
    ...(installed.prepare ? { prepare: compile(installed.prepare) } : {}),
    cases: installed.cases.map((test) => ({ ...test, argv: compile(test.argv) })),
  };
  if (!project.coursePackage) return spec;
  const privateFiles = new Set([
    ...Object.values(project.coursePackage.descriptor.runtime.evaluations),
    ...project.definition.visibility.answerKeys,
  ]);
  const resources = Object.fromEntries(
    Object.entries(project.coursePackage.bundle.files).filter(
      ([path]) => /^tests\//.test(path) && !privateFiles.has(path),
    ),
  );
  return { ...spec, resources };
}
/** Return observations, not a learner-controlled verdict. The host owns expected values.
 * This is learning feedback, not a hostile-code grading boundary: parent and child share the sandbox identity.
 */
export function evaluationCommand(spec: ProjectEvaluation, requestId: string) {
  const execution = {
    prepare: spec.prepare,
    resources: spec.resources,
    cases: spec.cases.map(({ id, argv, stdin }) => ({ id, argv, stdin })),
  };
  const payload = Buffer.from(JSON.stringify({ spec: execution, requestId })).toString('base64');
  const script = `import base64,json,subprocess,tempfile,os,hashlib,resource,re
cfg=json.loads(base64.b64decode(${JSON.stringify(payload)}))
spec=cfg['spec']; results=[]; build=True; buildReason=None; locations=[]
def diagnose(raw):
 text=re.sub(r'\\x1b\\[[0-?]*[ -/]*[@-~]','',raw); found=[]; compilation=False
 patterns=[r'(?m)^(?:\\[ERROR\\]\\s+)?([^\\n]+?\\.java):(?:\\[(\\d+),\\d+\\]|(\\d+)):?\\s*(.*)',r'File "([^"\\n]+\\.py)", line (\\d+)']
 for pattern in patterns:
  for m in re.finditer(pattern,text):
   if m[1].endswith('.py') and not re.search(r'(?:SyntaxError|IndentationError|TabError):',text): continue
   if m[1].endswith('.java') and re.fullmatch(r'(?:\\[ERROR\\]\\s+)?\\s*at\\s+[^\\s(]+\\([^()]*\\.java:\\d+\\)\\s*',m[0]): continue
   compilation=True; path=os.path.relpath(os.path.realpath(m[1].strip()),os.getcwd())
   if path=='..' or path.startswith('../'): continue
   line=int(m[2] or m[3]); message=m[4] if path.endswith('.java') else ''
   code='cannot_find_symbol' if 'cannot find symbol' in message else 'type_mismatch' if 'incompatible types' in message else 'invalid_method_call' if 'cannot be applied to given types' in message else 'missing_package' if re.search(r'package .+ does not exist',message) else 'compile_error'
   item={'file':path,'line':line,'code':code}
   if item not in found: found.append(item)
 return found[:8] if found or not compilation else None
with tempfile.TemporaryDirectory(prefix='pbl-check-') as out:
 resources=os.path.join(out,'evaluation'); os.makedirs(resources)
 for path,text in spec.get('resources',{}).items():
  target=os.path.join(resources,path); os.makedirs(os.path.dirname(target),exist_ok=True)
  with open(target,'w',encoding='utf-8') as f: f.write(text)
 def run(argv,stdin=''):
  with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
   proc=subprocess.Popen([a.replace('{build}',out).replace('{resources}',resources) for a in argv],stdin=subprocess.PIPE,stdout=output,stderr=errors,preexec_fn=lambda: resource.setrlimit(resource.RLIMIT_FSIZE,(1048576,1048576)))
   try: proc.communicate(input=stdin.encode('utf-8'),timeout=15)
   except subprocess.TimeoutExpired:
    proc.kill(); proc.communicate(); raise
   output.seek(0); data=output.read(1048577)
   errors.seek(0); diagnostic=diagnose(errors.read(65536).decode('utf-8',errors='replace')+'\\n'+data[:65536].decode('utf-8',errors='replace')) if proc.returncode else []
   if diagnostic is None: raise OSError('Assessment compilation could not be attributed to public source')
   if len(data)>1048576: return proc.returncode,None,diagnostic
   text=data.decode('utf-8').replace('\\r\\n','\\n').replace('\\r','\\n')
   return proc.returncode,hashlib.sha256(text.encode('utf-8')).hexdigest(),diagnostic
 try:
  if spec.get('prepare'):
   code,_,locations=run(spec['prepare']); build=code==0
   if not build: buildReason='build'
  for case in spec['cases']:
   observed=None; exitCode=None; reason='not_run'
   if build:
    try:
     exitCode,observed,diagnostic=run(case['argv'],case.get('stdin','')); locations.extend(diagnostic)
     reason='execution' if exitCode else ('output' if observed is None else None)
    except subprocess.TimeoutExpired: reason='timeout'
    except (OSError,UnicodeError): reason='environment'
   results.append({'id':case['id'],'stdoutDigest':observed,'exitCode':exitCode,'reason':reason})
 except subprocess.TimeoutExpired: build=False; buildReason='timeout'
 except OSError: build=False; buildReason='environment'
print('PBL_RESULT:'+cfg['requestId']+':'+json.dumps({'build':build,'buildReason':buildReason,'checks':results,'locations':locations[:8]},separators=(',',':')))
`;
  return `python3 -c ${quote(script)}`;
}
type Receipt = {
  build: boolean;
  buildReason?: 'build' | 'timeout' | 'environment';
  checks: NonNullable<NonNullable<EvaluationResult['publicDiagnostics']>['caseResults']>;
  locations: PublicEvaluationDiagnosticLocation[];
};

/** Only the installed case identities and a complete run-specific receipt establish evidence. */
function evaluationReceipt(
  spec: ProjectEvaluation,
  id: string,
  output: string,
  sourcePaths: readonly string[] = [],
): Receipt | null {
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
    const locations: PublicEvaluationDiagnosticLocation[] = [];
    if (value.locations != null) {
      if (!Array.isArray(value.locations) || value.locations.length > 8) return null;
      const codes = [
        'cannot_find_symbol',
        'type_mismatch',
        'invalid_method_call',
        'missing_package',
        'compile_error',
      ];
      for (const item of value.locations) {
        if (
          !sourcePaths.includes(item?.file) ||
          !Number.isSafeInteger(item.line) ||
          item.line < 1 ||
          item.line > 10_000_000 ||
          !codes.includes(item.code)
        )
          return null;
        if (
          !locations.some(
            (location) =>
              location.file === item.file &&
              location.line === item.line &&
              location.code === item.code,
          )
        )
          locations.push({ file: item.file, line: item.line, code: item.code });
      }
    }
    const reasons = ['output', 'execution', 'timeout', 'environment', 'not_run'];
    const checks: Receipt['checks'] = spec.cases.map((c, index) => {
      const result = value.checks[index];
      if (
        result?.id !== c.id ||
        (result.exitCode !== null && !Number.isSafeInteger(result.exitCode)) ||
        (result.stdoutDigest !== null && !/^[a-f0-9]{64}$/.test(result.stdoutDigest ?? '')) ||
        (result.reason != null && !reasons.includes(result.reason))
      )
        throw new Error('Invalid case receipt');
      if (result.reason == null && (result.exitCode !== 0 || !result.stdoutDigest || !value.build))
        throw new Error('Incomplete observation');
      const passed =
        value.build &&
        result.reason == null &&
        result.exitCode === 0 &&
        result.stdoutDigest ===
          createHash('sha256').update(c.stdout.replace(/\r\n?/g, '\n'), 'utf8').digest('hex');
      return {
        id: c.id,
        label: (c.label ?? c.id).slice(0, 160),
        passed,
        ...(!passed ? { reason: result.reason ?? 'output' } : {}),
      };
    });
    return { build: value.build, buildReason: value.buildReason ?? undefined, checks, locations };
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
  sourcePaths: readonly string[] = [],
): Pick<EvaluationResult, 'status' | 'failureKind' | 'publicFeedback' | 'publicDiagnostics'> {
  const receipt =
    observed.state === 'exited' && observed.exitCode === 0
      ? evaluationReceipt(spec, id, observed.stdout, sourcePaths)
      : null;
  if (
    !receipt ||
    receipt.buildReason === 'environment' ||
    receipt.buildReason === 'timeout' ||
    (!receipt.build && !receipt.locations.length) ||
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
  const kind =
    !receipt.build || receipt.locations.length
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
        : kind === 'compile'
          ? 'The code build failed before tests could run.'
          : 'Some checks did not satisfy the project contract.',
      reportGenerated: receipt.build && kind !== 'compile',
      caseResults: checks,
      ...(receipt.locations.length ? { locations: receipt.locations } : {}),
    },
  };
}
