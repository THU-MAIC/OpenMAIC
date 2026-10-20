'use client';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { LearningView } from '@/lib/pbl/v3/types';
import type { LearningWorkbench } from '@/lib/pbl/v3/workbench';
import { ProjectTerminal } from '@/components/sandbox/project-terminal';
import { sandboxErrorMessage } from '@/lib/sandbox/error-message';
import { SandboxRequestError } from '@/components/sandbox/client';
async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    headers: { 'content-type': 'application/json', 'x-openmaic-sandbox': '1' },
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok)
    throw new SandboxRequestError(
      sandboxErrorMessage(data.error),
      response.status,
      data.error?.code,
    );
  return data;
}
export function LearningWorkbenchPanel({
  view,
  pending,
  onRefresh,
  onSave,
  onCheckpoint,
  children,
}: {
  view: LearningView;
  pending: boolean;
  onRefresh: () => Promise<void>;
  onSave: (path: string, text: string, hash: string) => Promise<boolean>;
  onCheckpoint: () => Promise<boolean>;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const [work, setWork] = useState<LearningWorkbench | null>(null),
    [error, setError] = useState(''),
    [working, setWorking] = useState(false),
    [fileLoading, setFileLoading] = useState(false);
  const [path, setPath] = useState('PLAN.md'),
    [text, setText] = useState(''),
    [loaded, setLoaded] = useState<{
      path: string;
      text: string;
      hash: string;
      environment: string;
    } | null>(null);
  const [newPath, setNewPath] = useState(''),
    [shell, setShell] = useState(''),
    [terminal, setTerminal] = useState(''),
    [preview, setPreview] = useState('');
  const sequence = useRef(0),
    current = useRef(view);
  current.current = view;
  const dirty = !!loaded && text !== loaded.text;
  const dirtyBuffer = useRef(dirty);
  dirtyBuffer.current = dirty;
  const invalidateRead = useCallback(() => {
    sequence.current++;
  }, []);
  const disabled = pending || working || view.busy || !view.environment?.ready;
  const button = 'rounded border px-3 py-2 text-sm disabled:opacity-40';
  const refresh = useCallback(async () => {
    if (!view.environment?.ready) return;
    const id = view.environmentId;
    const next = await request<LearningWorkbench>(
      `/api/pbl/v3/workspace?id=${encodeURIComponent(view.id)}`,
    );
    if (current.current.environmentId === id)
      setWork((prior) =>
        !prior || prior.environmentId !== next.environmentId || prior.revision <= next.revision
          ? next
          : prior,
      );
  }, [view.id, view.environmentId, view.environment?.ready]);
  useEffect(() => {
    setWork(null);
    setTerminal('');
    setPreview('');
    void refresh().catch((e) => setError(e.message));
  }, [refresh]);
  useEffect(() => {
    if (!view.environment?.ready) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh().catch((e) => setError(e.message));
    }, 3000);
    return () => clearInterval(timer);
  }, [refresh, view.environment?.ready]);
  const load = useCallback(async () => {
    if (!view.environment?.ready) return;
    const ticket = ++sequence.current,
      env = view.environmentId!;
    setFileLoading(true);
    try {
      const data = await request<{ text: string; hash: string }>(
        `/api/pbl/v3?id=${encodeURIComponent(view.id)}&file=${encodeURIComponent(path)}`,
      );
      if (ticket !== sequence.current || env !== current.current.environmentId) return;
      setText(data.text);
      setLoaded({ ...data, path, environment: env });
    } finally {
      if (ticket === sequence.current) setFileLoading(false);
    }
  }, [view.id, view.environmentId, view.environment?.ready, path]);
  useEffect(() => {
    // Never replace an unsaved buffer because polling, reconnection or recovery changed the environment.
    if (!dirtyBuffer.current) void load().catch((e) => setError(e.message));
    else setFileLoading(false);
    return invalidateRead;
  }, [load, invalidateRead]);
  const run = async (action: string, payload: Record<string, unknown> = {}) => {
    if (action !== 'stop') setWorking(true);
    setError('');
    try {
      const selected = current.current;
      const result = await request<unknown>('/api/pbl/v3/workspace', {
        studyId: selected.id,
        command: {
          id: crypto.randomUUID(),
          revision: selected.revision,
          environmentId: selected.environmentId,
          action,
          ...payload,
        },
      });
      if (selected.environmentId !== current.current.environmentId) return;
      if (action === 'terminal') setTerminal((result as { id: string }).id);
      if (action === 'preview') setPreview((result as { url: string }).url);
      if (action === 'stop') {
        setTerminal('');
        setPreview('');
      }
      if (action === 'create' || action === 'rename') {
        setPath(String(action === 'create' ? payload.path : payload.destination));
        setLoaded(null);
        setText('');
        setNewPath('');
      }
      if (action === 'delete') {
        setPath('PLAN.md');
        setLoaded(null);
        setText('');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      await onRefresh().catch(() => {});
      await refresh().catch(() => {});
      if (action !== 'stop') setWorking(false);
    }
  };
  const transport = useMemo(
    () => ({
      eventsUrl: `/api/pbl/v3/workspace/terminal?id=${encodeURIComponent(view.id)}&environmentId=${encodeURIComponent(view.environmentId ?? '')}&terminalId=${encodeURIComponent(terminal)}`,
      send: async (
        body: { action: 'input'; data: string } | { action: 'resize'; cols: number; rows: number },
      ) => {
        const latest = current.current;
        return request('/api/pbl/v3/workspace', {
          studyId: latest.id,
          command: {
            id: crypto.randomUUID(),
            revision: latest.revision,
            environmentId: latest.environmentId,
            action: 'input',
            terminalId: terminal,
            ...(body.action === 'input'
              ? { data: body.data }
              : { cols: body.cols, rows: body.rows }),
          },
        });
      },
    }),
    [view.id, view.environmentId, terminal],
  );
  const editable =
    view.actions.includes('edit') && (work?.planning ? path === 'PLAN.md' : path !== 'PLAN.md');
  const stale =
    loaded?.environment !== view.environmentId ||
    loaded?.path !== path ||
    !view.files.includes(path);
  return (
    <div className="space-y-3 rounded-lg border p-4">
      <h3 className="font-semibold">{t('pblV3.files')}</h3>
      {error && <p role="alert">{error}</p>}
      {dirty && <p role="status">{t('pblV3.workbench.unsaved')}</p>}
      {loaded && stale && <p role="alert">{t('pblV3.workbench.staleBuffer')}</p>}
      <div className="flex flex-wrap gap-2">
        <select
          aria-label={t('pblV3.files')}
          className="rounded border p-2"
          value={path}
          disabled={disabled || dirty}
          onChange={(e) => {
            sequence.current++;
            setLoaded(null);
            setText('');
            setPath(e.target.value);
          }}
        >
          {view.files.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <button
          className={button}
          disabled={disabled}
          onClick={() => void load().catch((e) => setError(e.message))}
        >
          {t(dirty ? 'pblV3.workbench.discard' : 'pblV3.reloadFile')}
        </button>
      </div>
      <textarea
        aria-label={t('pblV3.editor')}
        spellCheck={false}
        className="min-h-64 w-full rounded border bg-muted/30 p-3 font-mono text-sm"
        value={text}
        readOnly={disabled || fileLoading || stale || !editable}
        onChange={(e) => setText(e.target.value)}
      />
      <button
        className={button}
        disabled={disabled || fileLoading || stale || !editable}
        onClick={() =>
          void (async () => {
            if (loaded && (await onSave(path, text, loaded.hash)))
              await load().catch((e) => setError(e.message));
          })()
        }
      >
        {t('pblV3.saveFile')}
      </button>
      {work?.canManageFiles && (
        <fieldset className="space-y-2">
          <legend>{t('pblV3.workbench.manageFiles')}</legend>
          <input
            aria-label={t('pblV3.workbench.newPath')}
            className="w-full rounded border p-2"
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
          />
          <button
            className={button}
            disabled={disabled || dirty || !newPath.trim()}
            onClick={() => void run('create', { path: newPath, text: '' })}
          >
            {t('pblV3.workbench.create')}
          </button>{' '}
          <button
            className={button}
            disabled={disabled || dirty || stale || path === 'PLAN.md' || !newPath.trim()}
            onClick={() =>
              void run('rename', { path, destination: newPath, expectedHash: loaded?.hash })
            }
          >
            {t('pblV3.workbench.rename')}
          </button>{' '}
          <button
            className={button}
            disabled={disabled || dirty || stale || path === 'PLAN.md'}
            onClick={() => {
              if (window.confirm(t('pblV3.workbench.confirmDelete', { path })))
                void run('delete', { path, expectedHash: loaded?.hash });
            }}
          >
            {t('pblV3.workbench.delete')}
          </button>
        </fieldset>
      )}
      <div className="space-y-2 border-t pt-3">
        <h4 className="font-semibold">{t('pblV3.workbench.execution')}</h4>
        <p className="text-sm">{t('pblV3.workbench.executionNotice')}</p>
        <textarea
          aria-label={t('pblV3.workbench.command')}
          className="w-full rounded border p-2 font-mono"
          value={shell}
          onChange={(e) => setShell(e.target.value)}
        />
        <button
          className={button}
          disabled={disabled || dirty || !work?.canRun || !shell.trim()}
          onClick={() => void run('run', { text: shell })}
        >
          {t('pblV3.workbench.run')}
        </button>{' '}
        <button
          className={button}
          disabled={disabled || dirty || !work?.canRun}
          onClick={() => void run('terminal')}
        >
          {t('pblV3.workbench.openTerminal')}
        </button>{' '}
        <button className={button} disabled={!view.environmentId} onClick={() => void run('stop')}>
          {t('pblV3.workbench.stop')}
        </button>
        {work?.commands.map((c) => (
          <details key={c.id} open={['starting', 'running', 'unknown'].includes(c.state)}>
            <summary>{t(`pblV3.workbench.commandStates.${c.state}`)}</summary>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-sm">
              {c.stdout}
              {'\n'}
              {c.stderr}
            </pre>
          </details>
        ))}
        {terminal && work?.canRun && (
          <ProjectTerminal
            key={`${view.environmentId}:${terminal}`}
            environmentId={view.environmentId!}
            terminalId={terminal}
            transport={transport}
          />
        )}
        {!terminal &&
          work?.terminals
            .filter((t) => t.state === 'running')
            .map((item) => (
              <button
                key={item.id}
                className={button}
                disabled={!work.canRun}
                onClick={() => setTerminal(item.id)}
              >
                {t('sandbox.reconnect')}
              </button>
            ))}
        {work?.ports.map((port) => (
          <button
            key={port}
            className={button}
            disabled={disabled || !work.canRun}
            onClick={() => void run('preview', { port })}
          >
            {t('pblV3.workbench.preview', { port })}
          </button>
        ))}
        {preview && work?.canRun && (
          <iframe
            title={t('pblV3.workbench.application')}
            className="h-96 w-full rounded border"
            src={preview}
            sandbox="allow-scripts allow-forms allow-same-origin allow-downloads"
            referrerPolicy="no-referrer"
          />
        )}
      </div>
      <div className="space-y-2 border-t pt-3">
        <p>
          {work?.checkpoint
            ? t('pblV3.workbench.savedAt', {
                time: new Date(work.checkpoint.createdAt).toLocaleString(),
              })
            : t('pblV3.workbench.notSaved')}
        </p>
        <button
          className={button}
          disabled={disabled || dirty}
          onClick={() =>
            void (async () => {
              await onCheckpoint();
              await refresh().catch((e) => setError(e.message));
            })()
          }
        >
          {t('pblV3.checkpoint')}
        </button>
        <p className="text-xs text-muted-foreground">{t('pblV3.saveNotice')}</p>
        {children}
      </div>
    </div>
  );
}
