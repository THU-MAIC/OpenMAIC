'use client';
import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SandboxCommandResult, SandboxEnvironment } from '@/lib/sandbox/types';
import { sandboxApi as api, sandboxRequest, SandboxRequestError } from './client';
import { ProjectTerminal } from './project-terminal';

type Checkpoint = { revision: number; createdAt: string; bytes: number };
type Files = { checkpoint: Checkpoint | null; files: Array<{ path: string; bytes: number }> };
const button = 'rounded-md border px-3 py-2 text-sm hover:bg-muted disabled:opacity-40';
const field = 'w-full rounded-md border bg-background p-2 font-mono text-sm';

/** Host-selected stable workspace ID. Independent of course DSL, programming language and provider SDK. */
export function ProjectWorkspace({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const [env, setEnv] = useState<SandboxEnvironment | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<Checkpoint | null>(null);
  const [files, setFiles] = useState<Files['files']>([]);
  const [path, setPath] = useState('main.py');
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [command, setCommand] = useState('');
  const [result, setResult] = useState<SandboxCommandResult | null>(null);
  const [commands, setCommands] = useState<Array<{ id: string; state: string }>>([]);
  const [terminal, setTerminal] = useState('');
  const [port, setPort] = useState('3000');
  const [preview, setPreview] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [allowWrites, setAllowWrites] = useState(false);
  const [allowCommands, setAllowCommands] = useState(false);
  const [notice, setNotice] = useState('');
  const [capabilities, setCapabilities] = useState<{
    lifetimeMs: number;
    storage: { available: boolean };
    preview: { browser: boolean };
  } | null>(null);
  const mounted = useRef(true);
  const running = env?.state === 'running' && env.workspaceReady;
  const key = `openmaic.workspace.operation:${workspaceId}`;
  const refresh = useCallback(async () => {
    setCapabilities(await sandboxRequest('/api/sandbox/capabilities'));
    const rows = await api<SandboxEnvironment[]>();
    const current = rows.find((row) => row.workspaceId === workspaceId) ?? null;
    setEnv(current);
    if (current) {
      const contents = await api<Files>(`/${current.id}/workspace`);
      setSaved(contents.checkpoint);
      setFiles(contents.files);
      setCommands(await api(`/${current.id}/commands`));
      const terminals = await api<Array<{ id: string; state: string }>>(`/${current.id}/terminals`);
      setTerminal(terminals.find((t) => t.state !== 'closed')?.id ?? '');
    } else {
      const checkpoints =
        await sandboxRequest<Array<Checkpoint & { workspaceId: string }>>(
          '/api/sandbox/workspaces',
        );
      setSaved(checkpoints.find((c) => c.workspaceId === workspaceId) ?? null);
      setFiles([]);
      setCommands([]);
      setTerminal('');
    }
  }, [workspaceId]);
  async function perform(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('sandbox.requestFailed'));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    void refresh().catch((e) => setError(e instanceof Error ? e.message : t('sandbox.loadFailed')));
    return () => {
      mounted.current = false;
    };
  }, [refresh, t]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const resultId = result?.id;
  const resultState = result?.state;
  // Poll results only. Reading status never extends the billable environment lease.
  useEffect(() => {
    if (
      !env ||
      !resultId ||
      !resultState ||
      !['starting', 'running', 'unknown'].includes(resultState)
    )
      return;
    const id = env.id;
    const commandId = resultId;
    let active = true;
    const timer = setInterval(() => {
      void api<SandboxCommandResult>(`/${id}/commands/${commandId}`).then(
        (value) => {
          if (active) setResult(value);
        },
        () => {},
      );
    }, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [env, resultId, resultState]);
  async function open() {
    let requestId = localStorage.getItem(key);
    if (!requestId) {
      requestId = crypto.randomUUID();
      localStorage.setItem(key, requestId);
    }
    let current: SandboxEnvironment;
    try {
      current = await api<SandboxEnvironment>('', 'POST', {
        requestId,
        workspaceId,
        profile: 'code',
      });
    } catch (error) {
      // Only an authoritative ownership/not-found response invalidates this operation.
      // Timeouts and unknown outcomes must retain its idempotency key.
      if (
        error instanceof SandboxRequestError &&
        error.status === 404 &&
        error.code === 'SANDBOX_NOT_FOUND'
      ) {
        if (localStorage.getItem(key) === requestId) localStorage.removeItem(key);
      }
      throw error;
    }
    // A completed old operation is safe to replace; uncertain creates keep the same ID.
    if (current.state === 'destroyed') {
      requestId = crypto.randomUUID();
      localStorage.setItem(key, requestId);
      current = await api<SandboxEnvironment>('', 'POST', {
        requestId,
        workspaceId,
        profile: 'code',
      });
    }
    setEnv(current);
    await refresh();
  }
  async function load(name: string) {
    if (dirty && !window.confirm(t('sandbox.discardChanges'))) return;
    const data = await api<{ text: string }>(`/${env!.id}/files?path=${encodeURIComponent(name)}`);
    setPath(name);
    setText(data.text);
    setDirty(false);
  }
  async function saveFile() {
    await api(`/${env!.id}/files`, 'PUT', { path, text });
    setDirty(false);
  }
  async function checkpoint(release: boolean) {
    if (dirty) await saveFile();
    const data = await api<{ checkpoint: { revision: number; bytes: number }; released: boolean }>(
      `/${env!.id}/workspace`,
      'POST',
      {
        action: release ? 'save-and-release' : 'save',
        expectedRevision: saved?.revision ?? 0,
      },
    );
    setSaved({ ...data.checkpoint, createdAt: new Date().toISOString() });
    if (release) {
      localStorage.removeItem(key);
      setPreview('');
    }
    await refresh();
    setNotice(release ? t('sandbox.savedReleased') : t('sandbox.saved'));
  }
  return (
    <section className="mx-auto max-w-7xl space-y-4 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t('sandbox.workspace')}</h1>
          <p className="text-sm text-muted-foreground">
            {workspaceId} · {env ? t(`sandbox.states.${env.state}`) : t('sandbox.notRunning')}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className={button} disabled={busy || !!env} onClick={() => void perform(open)}>
            {t('sandbox.openProject')}
          </button>
          <button className={button} disabled={busy} onClick={() => void perform(refresh)}>
            {t('sandbox.refresh')}
          </button>
          {env && (
            <button
              className={button}
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  await api(`/${env.id}`, 'POST', { action: 'reconcile' });
                  await refresh();
                })
              }
            >
              {t('sandbox.reconnect')}
            </button>
          )}
          {running && (
            <button
              className={button}
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const data = await api<{ lifetimeMs: number }>(`/${env!.id}`, 'POST', {
                    action: 'renew',
                  });
                  setNotice(t('sandbox.renewed', { minutes: Math.floor(data.lifetimeMs / 60000) }));
                })
              }
            >
              {t('sandbox.keepWorking')}
            </button>
          )}
        </div>
      </header>
      <p className="text-sm text-muted-foreground">
        {capabilities?.storage.available
          ? t('sandbox.saveAdvice')
          : t('sandbox.storageUnavailable')}
      </p>
      {error && (
        <p role="alert" className="rounded border border-red-400 p-3 text-red-600">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="rounded border p-3 text-sm">
          {notice}
        </p>
      )}
      {env && !env.workspaceReady && (
        <button
          className={button}
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              await api(`/${env.id}/workspace`, 'POST', { action: 'restore' });
              await refresh();
            })
          }
        >
          {t('sandbox.retryRestore')}
        </button>
      )}
      <div className="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="space-y-2 rounded-lg border p-3">
          <h2 className="font-medium">{t('sandbox.files')}</h2>
          {files.map((file) => (
            <button
              className="block w-full truncate text-left font-mono text-xs hover:underline"
              key={file.path}
              disabled={busy || !running}
              title={file.path}
              onClick={() => void perform(() => load(file.path))}
            >
              {file.path}
            </button>
          ))}
          {!files.length && <p className="text-sm text-muted-foreground">{t('sandbox.noFiles')}</p>}
        </aside>
        <div className="space-y-3 rounded-lg border p-4">
          <label className="block text-sm">
            {t('sandbox.filePath')}
            <input
              className={field}
              value={path}
              disabled={busy}
              onChange={(e) => setPath(e.target.value)}
            />
          </label>
          <textarea
            aria-label={t('sandbox.fileEditor')}
            disabled={busy}
            className={`${field} min-h-80`}
            spellCheck={false}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setDirty(true);
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              className={button}
              disabled={busy || !running}
              onClick={() =>
                void perform(async () => {
                  await saveFile();
                  await refresh();
                  setNotice(t('sandbox.fileWritten'));
                })
              }
            >
              {t('sandbox.writeFile')}
              {dirty ? ' *' : ''}
            </button>
            <button
              className={button}
              disabled={busy || !running || !capabilities?.storage.available}
              onClick={() => void perform(() => checkpoint(false))}
            >
              {t('sandbox.saveCheckpoint')}
            </button>
            <button
              className={button}
              disabled={busy || !running || !capabilities?.storage.available}
              onClick={() => void perform(() => checkpoint(true))}
            >
              {t('sandbox.saveRelease')}
            </button>
            <span className="text-xs text-muted-foreground">
              {saved
                ? t('sandbox.checkpoint', {
                    revision: saved.revision,
                    time: new Date(saved.createdAt).toLocaleString(),
                  })
                : t('sandbox.noCheckpoint')}
            </span>
          </div>
        </div>
      </div>
      <section className="space-y-3 rounded-lg border p-4">
        <h2 className="font-medium">{t('sandbox.run')}</h2>
        <input
          aria-label={t('sandbox.shellCommand')}
          className={field}
          placeholder="python3 main.py"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
        />
        <button
          className={button}
          disabled={busy || !running || !command.trim()}
          onClick={() =>
            void perform(async () => {
              const requestId = crypto.randomUUID();
              // Make the recovery ID visible even if the response is lost.
              setCommands((old) => [{ id: requestId, state: 'unknown' }, ...old]);
              setResult(
                await api(`/${env!.id}/commands`, 'POST', {
                  requestId,
                  command,
                  timeoutMs: Math.min(240_000, capabilities?.lifetimeMs ?? 60_000),
                }),
              );
            })
          }
        >
          {t('sandbox.runCommand')}
        </button>
        <div className="flex flex-wrap gap-2">
          {commands.map((c) => (
            <span key={c.id} className="flex gap-1 text-xs">
              <button
                className="underline"
                onClick={() =>
                  void perform(async () => {
                    setResult(await api(`/${env!.id}/commands/${c.id}`));
                  })
                }
              >
                {t('sandbox.readCommand', { id: c.id.slice(0, 8) })}
              </button>
              <button
                className="underline"
                disabled={busy || !running}
                onClick={() =>
                  void perform(async () => {
                    await api(`/${env!.id}/commands/${c.id}`, 'DELETE');
                    setResult(await api(`/${env!.id}/commands/${c.id}`));
                  })
                }
              >
                {t('sandbox.stop')}
              </button>
            </span>
          ))}
        </div>
        {result && (
          <>
            <p className="text-xs">
              {t(`sandbox.states.${result.state}`)} ·{' '}
              {t('sandbox.exit', { code: result.exitCode ?? '—' })}
              {result.truncated ? t('sandbox.truncated') : ''}
            </p>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">
              {result.stdout}
              {result.stderr}
            </pre>
          </>
        )}
      </section>
      <section className="space-y-3 rounded-lg border p-4">
        <div className="flex items-center gap-3">
          <h2 className="font-medium">{t('sandbox.terminal')}</h2>
          {!terminal ? (
            <button
              className={button}
              disabled={busy || !running}
              onClick={() =>
                void perform(async () => {
                  const known = await api<Array<{ id: string; state: string }>>(
                    `/${env!.id}/terminals`,
                  );
                  const t =
                    known.find((t) => t.state !== 'closed') ??
                    (await api<{ id: string }>(`/${env!.id}/terminals`, 'POST', {
                      requestId: crypto.randomUUID(),
                      cols: 100,
                      rows: 24,
                    }));
                  setTerminal(t.id);
                })
              }
            >
              {t('sandbox.openTerminal')}
            </button>
          ) : (
            <button
              className={button}
              disabled={busy || !running}
              onClick={() =>
                void perform(async () => {
                  await api(`/${env!.id}/terminals/${terminal}`, 'DELETE');
                  setTerminal('');
                })
              }
            >
              {t('sandbox.closeShell')}
            </button>
          )}
        </div>
        {terminal && running && <ProjectTerminal environmentId={env!.id} terminalId={terminal} />}
      </section>
      <section className="space-y-3 rounded-lg border p-4">
        <h2 className="font-medium">{t('sandbox.preview')}</h2>
        {capabilities && !capabilities.preview.browser && (
          <p className="text-sm text-muted-foreground">{t('sandbox.previewUnavailable')}</p>
        )}
        <div className="flex gap-2">
          <input
            aria-label={t('sandbox.port')}
            className="w-28 rounded border p-2"
            type="number"
            value={port}
            onChange={(e) => setPort(e.target.value)}
          />
          <button
            className={button}
            disabled={busy || !running || !capabilities?.preview.browser}
            onClick={() =>
              void perform(async () => {
                const p = await api<{ url: string }>(`/${env!.id}/preview`, 'POST', {
                  port: Number(port),
                });
                setPreview(p.url);
              })
            }
          >
            {t('sandbox.openPreview')}
          </button>
          {preview && (
            <>
              <a className={button} href={preview} target="_blank" rel="noopener noreferrer">
                {t('sandbox.newTab')}
              </a>
              <button
                className={button}
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await api(`/${env!.id}/preview`, 'DELETE');
                    setPreview('');
                  })
                }
              >
                {t('sandbox.closePreview')}
              </button>
            </>
          )}
        </div>
        {preview && <p className="text-sm text-muted-foreground">{t('sandbox.previewAdvice')}</p>}
        {preview && (
          <iframe
            title={t('sandbox.application')}
            className="h-96 w-full rounded border"
            src={preview}
            sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"
            referrerPolicy="no-referrer"
          />
        )}
      </section>
      <details className="space-y-3 rounded-lg border p-4">
        <summary>{t('sandbox.connectAgent')}</summary>
        <p className="text-sm">{t('sandbox.agentAdvice')}</p>
        <input
          className={field}
          aria-label={t('sandbox.agentSession')}
          placeholder={t('sandbox.sessionId')}
          value={sessionId}
          onChange={(e) => setSessionId(e.target.value)}
        />
        <div className="flex gap-4 text-sm">
          <label>
            <input
              type="checkbox"
              checked={allowWrites}
              onChange={(e) => setAllowWrites(e.target.checked)}
            />{' '}
            {t('sandbox.allowWrites')}
          </label>
          <label>
            <input
              type="checkbox"
              checked={allowCommands}
              onChange={(e) => setAllowCommands(e.target.checked)}
            />{' '}
            {t('sandbox.allowCommands')}
          </label>
        </div>
        <button
          className={button}
          disabled={busy || !running || !sessionId}
          onClick={() =>
            void perform(async () => {
              await api(`/${env!.id}/agent-session`, 'POST', {
                sessionId,
                allowWrites,
                allowCommands,
              });
              setNotice(t('sandbox.sessionConnected'));
            })
          }
        >
          {t('sandbox.connectSession')}
        </button>
        <button
          className={button}
          disabled={busy || !env || !sessionId}
          onClick={() =>
            void perform(async () => {
              await api(`/${env!.id}/agent-session`, 'DELETE', { sessionId });
              setNotice(t('sandbox.sessionRevoked'));
            })
          }
        >
          {t('sandbox.revokeAccess')}
        </button>
      </details>
      {!env && saved && (
        <details className="rounded-lg border p-4">
          <summary>{t('sandbox.deleteSaved')}</summary>
          <p className="my-2 text-sm">{t('sandbox.deleteAdvice')}</p>
          <button
            className={button}
            disabled={busy}
            onClick={() => {
              if (window.confirm(t('sandbox.deleteConfirm')))
                void perform(async () => {
                  await sandboxRequest('/api/sandbox/workspaces', 'DELETE', {
                    workspaceId,
                    revision: saved.revision,
                  });
                  await refresh();
                });
            }}
          >
            {t('sandbox.deleteCheckpoint')}
          </button>
        </details>
      )}
      {env && (
        <details className="rounded-lg border p-4">
          <summary>{t('sandbox.releaseWithoutSave')}</summary>
          <p className="my-2 text-sm">{t('sandbox.releaseAdvice')}</p>
          <button
            className={button}
            disabled={busy}
            onClick={() => {
              if (window.confirm(t('sandbox.releaseConfirm')))
                void perform(async () => {
                  const released = await api<SandboxEnvironment>(`/${env.id}`, 'DELETE');
                  if (released.state === 'destroyed') {
                    localStorage.removeItem(key);
                    setPreview('');
                    setText('');
                    setDirty(false);
                  }
                  await refresh();
                });
            }}
          >
            {t('sandbox.release')}
          </button>
        </details>
      )}
    </section>
  );
}
