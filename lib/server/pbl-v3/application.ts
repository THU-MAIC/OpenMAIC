import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { OwnerPrincipal } from '@/lib/server/identity/types';
import type { ApplicationObservation } from '@/lib/pbl/v3/application';
import { SandboxService } from '@/lib/server/sandbox/service';
import {
  learningWorkspaceId,
  withLearningWorkspaceAccess,
} from '@/lib/server/sandbox/managed-workspace';
import { previewConfig } from '@/lib/server/sandbox/preview';
import { SandboxError, sandboxConflict, sandboxInvalid } from '@/lib/sandbox/errors';
import { LearningStore, type Study } from './store';
import { busy, projectFor, readFiles, requireEnvironment, stageKey } from './runtime';
import {
  assertEnvironmentReady,
  assertEnvironmentWritable,
  environmentReleaseCommitted,
  touchEnvironment,
} from './environment';
import { projectFiles } from './workspace-files';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const active = (state: string) => ['starting', 'running', 'unknown'].includes(state);
export function applicationFingerprint(files: Record<string, string>) {
  const hash = createHash('sha256');
  for (const path of Object.keys(files).sort()) hash.update(path + '\0' + files[path] + '\0');
  return hash.digest('hex');
}

/** The gateway has a signed grant, not a request-owner context or a teaching scope. */
export async function assertLearningPreview(
  ownerId: string,
  workspaceId: string,
  environmentId: string,
  port: number,
) {
  const row = await (await LearningStore.open()).get(workspaceId.slice(4), ownerId);
  const application = projectFor(row).application;
  if (!application || application.port !== port)
    throw new SandboxError('PBL_WORKSPACE_MANAGED', 409, 'Application access was revoked.');
  if (
    learningWorkspaceId(row.id) !== workspaceId ||
    row.environment_id !== environmentId ||
    environmentReleaseCommitted(row, environmentId)
  )
    throw sandboxConflict('Application access was revoked.', 'ENVIRONMENT_CHANGED');
}

interface ApplicationRun {
  environmentId: string;
  epoch: number;
  commandId: string;
  sourceHash: string;
  startedAt: string;
}
async function lastRun(store: LearningStore, row: Study): Promise<ApplicationRun | null> {
  const result = await store.pool.query<{ result: ApplicationRun }>(
    `SELECT result FROM pbl_v3_commands WHERE study_id=$1 AND id LIKE 'application:%'
       AND result->>'environmentId'=$2 ORDER BY result->>'startedAt' DESC,id DESC LIMIT 1`,
    [row.id, requireEnvironment(row)],
  );
  return result.rows[0]?.result ?? null;
}

/** A start intent can commit before its command reservation. Absence proves no dispatch. */
async function applicationCommand(
  store: LearningStore,
  row: Study,
  run: ApplicationRun,
  service: SandboxService,
  signal?: AbortSignal,
) {
  const recorded = await store.pool.query(
    'SELECT id FROM sandbox_commands WHERE environment_id=$1 AND id=$2',
    [requireEnvironment(row), run.commandId],
  );
  return recorded.rows.length
    ? service.command(requireEnvironment(row), run.commandId, signal)
    : null;
}

/** A fixed read-only GET plus hashes of permitted sources; no browser-provided URL or shell. */
export function applicationProbeCommand(paths: string[], port: number, healthPath: string) {
  const config = Buffer.from(JSON.stringify({ paths, port, healthPath })).toString('base64');
  const script = `import base64,hashlib,json,pathlib,urllib.request,urllib.error
c=json.loads(base64.b64decode('${config}'))
h=hashlib.sha256(); root=pathlib.Path.cwd().resolve(); total=0
for name in c['paths']:
 p=root/name
 if not p.resolve().is_relative_to(root): raise ValueError('Source path escaped workspace')
 data=p.read_bytes(); total+=len(data)
 if total>1048576: raise ValueError('Source size limit exceeded')
 h.update(name.encode()+b'\\0'+data+b'\\0')
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs): return None
out={'sourceHash':h.hexdigest()}
try:
 with urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect()).open('http://127.0.0.1:'+str(c['port'])+c['healthPath'],timeout=1.5) as response:
  out['httpStatus']=response.status
except urllib.error.HTTPError as error: out['httpStatus']=error.code
except (urllib.error.URLError,TimeoutError,OSError): pass
print(json.dumps(out))`;
  return `python3 -c ${quote(script)}`;
}

/** Called under the study lock and a narrow, lease-fenced command scope. Never starts an app. */
export async function inspectApplication(
  store: LearningStore,
  row: Study,
  service: SandboxService,
  signal?: AbortSignal,
): Promise<ApplicationObservation> {
  const application = projectFor(row).application;
  if (!application) throw sandboxInvalid('This project does not declare an application.');
  const observedAt = new Date().toISOString(),
    environmentId = requireEnvironment(row);
  const run = await lastRun(store, row);
  if (!run || run.epoch !== (await service.workspaceEpoch(environmentId)))
    return { observedAt, state: 'stopped' };
  const command = await applicationCommand(store, row, run, service, signal);
  if (!command) return { observedAt, state: 'stopped', commandState: 'not-started' };
  if (!active(command.state))
    return {
      observedAt,
      state:
        command.exitCode === 0 || ['cancelled', 'timed_out'].includes(command.state)
          ? 'stopped'
          : 'failed',
      commandState: command.state,
      exitCode: command.exitCode,
      output: (command.stdout + '\n' + command.stderr).slice(-2000).trim(),
    };
  const id = randomUUID();
  let probe = await service.startCommand(
    environmentId,
    {
      requestId: id,
      command: applicationProbeCommand(
        await projectFiles(service, environmentId, projectFor(row), signal),
        application.port,
        application.healthPath,
      ),
      timeoutMs: 5_000,
    },
    run.epoch,
  );
  const deadline = Date.now() + 8_000;
  while (active(probe.state) && Date.now() < deadline) {
    await delay(100, undefined, { signal });
    probe = await service.command(environmentId, id, signal);
  }
  if (active(probe.state)) {
    await service.cancelCommand(environmentId, id);
    return { observedAt, state: 'unknown' };
  }
  try {
    const data = z
      .object({ sourceHash: z.string(), httpStatus: z.number().int().optional() })
      .parse(JSON.parse(probe.stdout));
    return {
      observedAt,
      state: data.httpStatus === undefined ? 'starting' : 'running',
      httpStatus: data.httpStatus,
      sourceChanged: data.sourceHash !== run.sourceHash,
    };
  } catch {
    return { observedAt, state: 'unknown' };
  }
}

const requestSchema = z
  .object({
    studyId: z.string().uuid(),
    id: z.string().uuid(),
    environmentId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    epoch: z.number().int().nonnegative(),
    action: z.enum(['open', 'restart', 'status', 'stop']),
  })
  .strict();
export async function applicationRequest(principal: OwnerPrincipal, input: unknown) {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success)
    throw sandboxInvalid('A current study, environment, revision and request ID are required.');
  const request = parsed.data,
    store = await LearningStore.open();
  return store.exclusive(request.studyId, async () => {
    const row = await store.get(request.studyId, principal.ownerId),
      application = projectFor(row).application;
    if (!application) throw sandboxInvalid('This project does not declare an application.');
    if (row.environment_id !== request.environmentId || row.revision !== request.revision)
      throw sandboxConflict(
        'The learning workspace changed. Refresh before continuing.',
        'PROGRESS_CHANGED',
      );
    if (row.evaluation || (await busy(store, row)))
      throw sandboxConflict('Wait for the current Agent or assessment.', 'STUDY_BUSY');
    const service = await SandboxService.forOwner(principal),
      environmentId = requireEnvironment(row);
    assertEnvironmentReady(await touchEnvironment(store, row, service));
    if ((await service.workspaceEpoch(environmentId)) !== request.epoch)
      throw sandboxConflict(
        'Workspace was stopped. Refresh before continuing.',
        'WORKSPACE_STOPPED',
      );
    if (request.action === 'open' || request.action === 'restart') previewConfig();
    await assertEnvironmentWritable(store, row.id, row.owner_id, environmentId);
    return withLearningWorkspaceAccess(
      {
        ownerId: row.owner_id,
        workspaceId: learningWorkspaceId(row.id),
        environmentIds: () => [environmentId],
        operations: ['command', 'preview'],
      },
      async () => {
        if (request.action === 'stop') {
          await service.stopApplications(environmentId);
          return {
            observedAt: new Date().toISOString(),
            state: 'stopped',
          } satisfies ApplicationObservation;
        }
        if (request.action !== 'status') {
          // A durable reservation precedes provider dispatch. A retry cannot restart a lost-ack command.
          const receiptId = `application:${request.id}`,
            hash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
          const receipt = (
            await store.pool.query<{ hash: string; result: ApplicationRun }>(
              'SELECT hash,result FROM pbl_v3_commands WHERE study_id=$1 AND id=$2',
              [row.id, receiptId],
            )
          ).rows[0];
          if (receipt && receipt.hash !== hash)
            throw sandboxConflict('Request ID was reused with different input.');
          const previous = await lastRun(store, row);
          const previousCommand =
            previous && previous.epoch === request.epoch
              ? await applicationCommand(store, row, previous, service)
              : null;
          const running = previousCommand && active(previousCommand.state);
          if (!receipt && (request.action === 'restart' || !running)) {
            await service.stopApplications(environmentId);
            const files = await readFiles(service, row),
              run: ApplicationRun = {
                environmentId,
                epoch: request.epoch,
                commandId: request.id,
                sourceHash: applicationFingerprint(files),
                startedAt: new Date().toISOString(),
              };
            await store.pool.query(
              'INSERT INTO pbl_v3_commands(study_id,id,hash,result,stage_key) VALUES($1,$2,$3,$4,$5)',
              [row.id, receiptId, hash, JSON.stringify(run), stageKey(row)],
            );
            await service.startApplicationCommand(
              environmentId,
              {
                requestId: run.commandId,
                command: `exec ${application.argv.map(quote).join(' ')}`,
              },
              request.epoch,
            );
          }
          if (receipt && previous?.commandId === receipt.result.commandId)
            await service.startApplicationCommand(
              environmentId,
              {
                requestId: previous.commandId,
                command: `exec ${application.argv.map(quote).join(' ')}`,
              },
              request.epoch,
            );
          await store.recordActivity(row.id, row.owner_id);
        }
        const observation = await inspectApplication(store, row, service);
        return {
          ...observation,
          ...(request.action !== 'status' && observation.state === 'running'
            ? { preview: await service.preview(environmentId, application.port, request.epoch) }
            : {}),
        };
      },
    );
  });
}
