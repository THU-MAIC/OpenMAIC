'use client';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels';
import { RefreshCw, FolderCog, Files, Play, Save, Square, Terminal, X, Globe } from 'lucide-react';
import { FileExplorer } from './file-explorer';
import { useProjectEditor } from './use-project-editor';
const CodeEditor = dynamic(() => import('./code-editor').then((m) => m.CodeEditor), { ssr: false });
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
  onDirtyChange,
  children,
}: {
  view: LearningView;
  pending: boolean;
  onRefresh: () => Promise<void>;
  onSave: (path: string, text: string, hash: string) => Promise<boolean>;
  onCheckpoint: () => Promise<boolean>;
  onDirtyChange: (dirty: boolean) => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const [work, setWork] = useState<LearningWorkbench | null>(null),
    [error, setError] = useState(''),
    [working, setWorking] = useState(false);
  const [newPath, setNewPath] = useState(''),
    [shell, setShell] = useState(''),
    [terminal, setTerminal] = useState(''),
    [preview, setPreview] = useState('');
  const [manage, setManage] = useState(false),
    [consoleOpen, setConsoleOpen] = useState(false),
    [consoleTab, setConsoleTab] = useState<'output' | 'terminal'>('output'),
    [editorTab, setEditorTab] = useState<'code' | 'preview'>('code');
  const showEvaluation =
    view.stage.kind !== 'check' && (view.actions.includes('compile') || !!view.evaluation);
  useEffect(() => {
    if (showEvaluation) {
      setConsoleOpen(true);
      setConsoleTab('output');
    }
  }, [showEvaluation]);
  const explorer = usePanelRef();
  const executionSequence = useRef(0),
    current = useRef(view);
  current.current = view;
  const editor = useProjectEditor(
    view,
    (path) =>
      request<{ text: string; hash: string }>(
        `/api/pbl/v3?id=${encodeURIComponent(view.id)}&file=${encodeURIComponent(path)}`,
      ),
    onSave,
    setError,
  );
  const { path, buffer, stale } = editor;
  const dirty = editor.anyDirty;
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  const disabled = pending || working || view.busy || !view.environment?.ready;
  const canEdit = (name: string) =>
    !!work?.canEdit &&
    view.actions.includes('edit') &&
    (work.planning ? name === 'PLAN.md' : name !== 'PLAN.md');
  const editable = canEdit(path);
  const canSave = !disabled && !editor.loading && !stale && !!buffer && editable;
  const save = () => {
    if (canSave) void editor.save();
  };
  const button =
    'inline-flex items-center gap-1.5 rounded px-2 py-1.5 text-xs hover:bg-muted disabled:opacity-40';
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const refresh = useCallback(async () => {
    if (!view.environment?.ready) return;
    const id = view.environmentId;
    const next = await request<LearningWorkbench>(
      `/api/pbl/v3/workspace?id=${encodeURIComponent(view.id)}`,
    );
    if (current.current.environmentId === id)
      setWork((prior) =>
        !prior ||
        prior.environmentId !== next.environmentId ||
        (prior.revision <= next.revision && prior.epoch <= next.epoch)
          ? next
          : prior,
      );
  }, [view.id, view.environmentId, view.environment?.ready]);
  useEffect(() => {
    executionSequence.current++;
    setWork(null);
    setTerminal('');
    setPreview('');
  }, [refresh]);
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
  }, [refresh, view.revision]);
  useEffect(() => {
    if (!view.environment?.ready) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh().catch((e) => setError(e.message));
    }, 3000);
    return () => clearInterval(timer);
  }, [refresh, view.environment?.ready]);
  const run = async (action: string, payload: Record<string, unknown> = {}) => {
    // Stop invalidates earlier creation responses even when the provider finishes later.
    if (action === 'stop') executionSequence.current++;
    const executionTicket = executionSequence.current;
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
          epoch: work?.epoch,
          action,
          ...payload,
        },
      });
      if (selected.environmentId !== current.current.environmentId) return;
      if (executionTicket !== executionSequence.current) return;
      if (action === 'terminal') {
        setTerminal((result as { id: string }).id);
        setConsoleOpen(true);
        setConsoleTab('terminal');
      }
      if (action === 'preview') {
        setPreview((result as { url: string }).url);
        setEditorTab('preview');
      }
      if (action === 'stop') {
        setTerminal('');
        setPreview('');
        setEditorTab('code');
      }
      if (action === 'create' || action === 'rename') {
        if (action === 'rename') editor.close(path);
        editor.select(String(action === 'create' ? payload.path : payload.destination));
        setNewPath('');
      }
      if (action === 'delete') {
        editor.close(path);
        editor.select('PLAN.md');
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
  const reload = () => {
    if (!editor.dirty(path) || window.confirm(t('pblV3.ide.discard', { path })))
      void editor.reload();
  };
  return (
    <section
      aria-label={t('pblV3.ide.workspace')}
      data-testid="pbl-ide"
      className="flex h-full min-h-0 min-w-0 flex-col bg-background"
    >
      {error && (
        <p
          role="alert"
          className="shrink-0 border-b bg-destructive/10 p-2 text-xs text-destructive"
        >
          {error}
        </p>
      )}
      {stale && (
        <p role="alert" className="shrink-0 border-b p-2 text-xs">
          {t('pblV3.workbench.staleBuffer')}
        </p>
      )}
      {manage && work?.canManageFiles && (
        <fieldset className="flex shrink-0 flex-wrap items-center gap-1 border-b p-2">
          <input
            aria-label={t('pblV3.workbench.newPath')}
            placeholder="src/example.py"
            className="min-w-0 flex-1 rounded border bg-background p-1 text-xs"
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
          />
          <button
            className={button}
            disabled={disabled || dirty || !newPath.trim()}
            onClick={() => void run('create', { path: newPath, text: '' })}
          >
            {t('pblV3.workbench.create')}
          </button>
          <button
            className={button}
            disabled={disabled || dirty || stale || path === 'PLAN.md' || !newPath.trim()}
            onClick={() =>
              void run('rename', { path, destination: newPath, expectedHash: buffer?.hash })
            }
          >
            {t('pblV3.workbench.rename')}
          </button>
          <button
            className={button}
            disabled={disabled || dirty || stale || path === 'PLAN.md'}
            onClick={() => {
              if (window.confirm(t('pblV3.workbench.confirmDelete', { path })))
                void run('delete', { path, expectedHash: buffer?.hash });
            }}
          >
            {t('pblV3.workbench.delete')}
          </button>
        </fieldset>
      )}
      <div className="min-h-0 flex-1">
        <Group orientation="horizontal">
          <Panel
            id="files"
            panelRef={explorer}
            defaultSize="24%"
            minSize="15%"
            maxSize="45%"
            collapsible
            className="h-full bg-muted/20"
          >
            <header className="flex shrink-0 flex-wrap items-center gap-1 border-b pbl-chrome px-2 py-1">
              <button
                className={button}
                aria-label={t('pblV3.ide.hideFiles')}
                title={t('pblV3.ide.toggleFiles')}
                onClick={() => {
                  if (explorer.current?.isCollapsed()) explorer.current.expand();
                  else explorer.current?.collapse();
                }}
              >
                <Files size={15} />
              </button>
              <span className="mr-auto text-xs font-semibold">
                {t('pblV3.files')}{' '}
                <span className="font-normal text-muted-foreground">{view.files.length}</span>
              </span>
            </header>
            <FileExplorer
              files={view.files}
              active={path}
              dirty={editor.dirty}
              editable={canEdit}
              onSelect={(p) => {
                editor.select(p);
                setEditorTab('code');
              }}
            />
          </Panel>
          <Separator
            aria-label={t('pblV3.ide.resizeFiles')}
            className="w-px bg-border hover:bg-primary"
          />
          <Panel id="editor" minSize="45%" className="flex h-full min-w-0 flex-col">
            <div className="pbl-chrome flex h-9 shrink-0 items-center border-b">
              <button
                className={button}
                aria-label={t('pblV3.ide.toggleFiles')}
                onClick={() =>
                  explorer.current?.isCollapsed()
                    ? explorer.current.expand()
                    : explorer.current?.collapse()
                }
              >
                <Files size={14} />
              </button>
              <div
                role="tablist"
                aria-label={t('pblV3.ide.openFiles')}
                className="flex min-w-0 flex-1 overflow-x-auto"
              >
                {editor.tabs.map((p) => (
                  <div key={p} className="flex shrink-0 items-center border-r">
                    <button
                      role="tab"
                      aria-selected={p === path && editorTab === 'code'}
                      className="border-t-2 border-transparent px-3 py-2 text-xs aria-selected:border-primary aria-selected:bg-background"
                      title={p}
                      onClick={() => {
                        editor.select(p);
                        setEditorTab('code');
                      }}
                    >
                      {p.split('/').at(-1)}
                      {editor.dirty(p) ? ' ●' : ''}
                    </button>
                    <button
                      className="p-1 hover:bg-muted"
                      aria-label={t('pblV3.ide.closeFile', { path: p })}
                      onClick={() => {
                        if (!editor.dirty(p) || window.confirm(t('pblV3.ide.discard', { path: p })))
                          editor.close(p);
                      }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
                {!!work?.ports.length && (
                  <button
                    role="tab"
                    aria-selected={editorTab === 'preview'}
                    className="px-3 py-2 text-xs aria-selected:bg-accent"
                    onClick={() => setEditorTab('preview')}
                  >
                    <Globe size={13} className="mr-1 inline" />
                    {t('pblV3.workbench.application')}
                  </button>
                )}
              </div>
              <button
                className={button}
                disabled={!canSave}
                onClick={save}
                aria-label={t('pblV3.saveFile')}
                title={t('pblV3.saveFile')}
              >
                <Save size={14} />
              </button>
              <button
                className={button}
                disabled={disabled}
                onClick={reload}
                aria-label={t(editor.dirty(path) ? 'pblV3.workbench.discard' : 'pblV3.reloadFile')}
                title={t('pblV3.reloadFile')}
              >
                <RefreshCw size={14} />
              </button>
              {work?.canManageFiles && (
                <button
                  className={button}
                  aria-label={t('pblV3.workbench.manageFiles')}
                  aria-expanded={manage}
                  onClick={() => setManage((v) => !v)}
                >
                  <FolderCog size={14} />
                </button>
              )}
            </div>
            <div className="relative min-h-0 flex-1">
              <div className="absolute inset-0" hidden={editorTab === 'preview'}>
                {buffer ? (
                  <CodeEditor
                    studyId={view.id}
                    path={path}
                    value={buffer.text}
                    readOnly={!canSave}
                    onChange={editor.edit}
                    onSave={save}
                  />
                ) : (
                  <p className="p-4 text-sm text-muted-foreground">
                    {t(view.environment?.ready ? 'pblV3.loading' : 'pblV3.environmentNotice')}
                  </p>
                )}
              </div>
              {editorTab === 'preview' && (!preview || !work?.canRun) && (
                <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
                  <Globe size={28} />
                  <strong className="text-foreground">{t('pblV3.workbench.application')}</strong>
                  <p className="max-w-sm">
                    {t(
                      work?.canRun ? 'pblV3.ide.previewNotStarted' : 'pblV3.ide.previewUnavailable',
                    )}
                  </p>
                  {work?.ports.map((port) => (
                    <button
                      key={port}
                      className={`${button} border`}
                      disabled={disabled || !work.canRun}
                      onClick={() => void run('preview', { port })}
                    >
                      {t('pblV3.ide.connectPreview')} · {port}
                    </button>
                  ))}
                </div>
              )}
              {preview && work?.canRun && (
                <iframe
                  title={t('pblV3.workbench.application')}
                  className="absolute inset-0 h-full w-full bg-white"
                  hidden={editorTab !== 'preview'}
                  src={preview}
                  sandbox="allow-scripts allow-forms allow-same-origin allow-downloads"
                  referrerPolicy="no-referrer"
                />
              )}
            </div>
          </Panel>
        </Group>
      </div>
      <div
        className="shrink-0 border-t bg-muted/10"
        style={{ height: consoleOpen ? '38%' : undefined }}
      >
        <div className="flex flex-wrap items-center gap-1 border-b px-2 py-1">
          <button
            className={button}
            aria-pressed={consoleOpen && consoleTab === 'output'}
            onClick={() => {
              setConsoleOpen(true);
              setConsoleTab('output');
            }}
          >
            {t('pblV3.ide.output')}
          </button>
          <button
            className={button}
            aria-pressed={consoleOpen && consoleTab === 'terminal'}
            onClick={() => {
              setConsoleOpen(true);
              setConsoleTab('terminal');
            }}
          >
            <Terminal size={13} />
            {t('pblV3.ide.terminal')}
          </button>
          {work?.ports.map((port) => (
            <button
              key={port}
              className={button}
              disabled={disabled || !work.canRun}
              onClick={() => void run('preview', { port })}
            >
              <Globe size={13} />
              {t('pblV3.workbench.preview', { port })}
            </button>
          ))}
          <button
            className={`${button} ml-auto`}
            disabled={!view.environmentId}
            onClick={() => void run('stop')}
          >
            <Square size={12} />
            {t('pblV3.workbench.stop')}
          </button>
          {consoleOpen && (
            <button
              className={button}
              aria-label={t('pblV3.ide.hideConsole')}
              onClick={() => setConsoleOpen(false)}
            >
              <X size={13} />
            </button>
          )}
        </div>
        <div hidden={!consoleOpen} className="h-[calc(100%_-_38px)] overflow-auto p-2">
          <div hidden={consoleTab !== 'output'} className="space-y-2">
            <p className="text-xs text-muted-foreground">{t('pblV3.workbench.executionNotice')}</p>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!disabled && !dirty && work?.canRun && shell.trim())
                  void run('run', { text: shell });
              }}
            >
              <input
                aria-label={t('pblV3.workbench.command')}
                placeholder="python3 src/app.py"
                className="min-w-0 flex-1 rounded border bg-background px-2 font-mono text-xs"
                value={shell}
                onChange={(e) => setShell(e.target.value)}
              />
              <button
                className={button}
                disabled={disabled || dirty || !work?.canRun || !shell.trim()}
              >
                <Play size={13} />
                {t('pblV3.workbench.run')}
              </button>
            </form>
            {work?.commands.map((c) => (
              <details key={c.id} open={['starting', 'running', 'unknown'].includes(c.state)}>
                <summary className="text-xs">
                  {t(`pblV3.workbench.commandStates.${c.state}`)}
                </summary>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-xs">
                  {c.stdout}
                  {'\n'}
                  {c.stderr}
                </pre>
              </details>
            ))}
            {children}
          </div>
          <div hidden={consoleTab !== 'terminal'}>
            <button
              className={button}
              disabled={disabled || dirty || !work?.canRun || !!terminal}
              onClick={() => void run('terminal')}
            >
              {t('pblV3.workbench.openTerminal')}
            </button>
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
            {terminal && work?.canRun && (
              <ProjectTerminal
                key={`${view.environmentId}:${terminal}`}
                environmentId={view.environmentId!}
                terminalId={terminal}
                transport={transport}
              />
            )}
          </div>
        </div>
      </div>
      <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t px-2 py-1 text-xs text-muted-foreground">
        <span className="mr-auto" title={t('pblV3.saveNotice')}>
          {work?.checkpoint
            ? t('pblV3.workbench.savedAt', {
                time: new Date(work.checkpoint.createdAt).toLocaleString(),
              })
            : t('pblV3.workbench.notSaved')}
        </span>
        {dirty && <span>{t('pblV3.workbench.unsaved')}</span>}
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
          <Save size={13} />
          {t('pblV3.checkpoint')}
        </button>
      </footer>
    </section>
  );
}
