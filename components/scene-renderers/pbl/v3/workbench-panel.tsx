'use client';
import { readPblJson } from '@/lib/pbl/v3/response';
import type { FileReference, FileChangeRange } from '@/lib/pbl/v3/file-reference';
import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels';
import {
  RefreshCw,
  FolderCog,
  Files,
  Play,
  Square,
  Terminal,
  X,
  LoaderCircle,
  Check,
  AlertCircle,
  ChevronLeft,
  PanelLeftOpen,
  LockKeyhole,
} from 'lucide-react';
import { PendingAction } from './pending-action';
import { environmentNotice, environmentNoticeKeys } from '@/lib/pbl/v3/environment-status';
import { projectEditAccess } from '@/lib/pbl/v3/edit-access';
import { FileExplorer } from './file-explorer';
import { useProjectEditor, type FileSaveReceipt, type FileSaveRequest } from './use-project-editor';
const CodeEditor = dynamic(() => import('./code-editor').then((m) => m.CodeEditor), { ssr: false });
import { useI18n } from '@/lib/hooks/use-i18n';
import type { LearningView } from '@/lib/pbl/v3/types';
import type { LearningWorkbench } from '@/lib/pbl/v3/workbench';
import { ProjectTerminal } from '@/components/sandbox/project-terminal';
import { sandboxErrorMessage } from '@/lib/sandbox/error-message';
import { SandboxRequestError } from '@/components/sandbox/client';
import { learningWorkbenchFeatures } from '@/lib/pbl/v3/presentation';

export async function workbenchRequest<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    headers: { 'content-type': 'application/json', 'x-openmaic-sandbox': '1' },
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
  });
  const data = await readPblJson(response);
  if (!response.ok)
    throw new SandboxRequestError(
      sandboxErrorMessage(data.error),
      response.status,
      data.error?.code,
      data.error?.reason,
    );
  return data;
}
export function LearningWorkbenchPanel({
  view,
  workbench,
  fileTarget,
  onFileTargetConsumed,
  pending,
  pendingAction,
  onRefresh,
  onSave,
  onDirtyChange,
}: {
  view: LearningView;
  fileTarget?: (FileReference & { requestId: number }) | null;
  onFileTargetConsumed: (requestId: number) => void;
  workbench: LearningWorkbench | null;
  pending: boolean;
  pendingAction: string | null;
  onRefresh: () => Promise<void>;
  onSave: (
    path: string,
    text: string,
    hash: string,
    request: FileSaveRequest,
  ) => Promise<FileSaveReceipt>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { t } = useI18n();
  const work =
    workbench?.environmentId === view.environmentId && workbench.revision >= view.revision
      ? workbench
      : null;
  const [error, setError] = useState(''),
    [operation, setOperation] = useState<string | null>(null);
  const working = operation !== null;
  const operationSequence = useRef(0);
  const [newPath, setNewPath] = useState(''),
    [shell, setShell] = useState(''),
    [terminal, setTerminal] = useState('');
  const [manage, setManage] = useState(false),
    [consoleOpen, setConsoleOpen] = useState(false),
    [consoleTab, setConsoleTab] = useState<'output' | 'terminal'>('output');
  const explorer = usePanelRef();
  const [filesCollapsed, setFilesCollapsed] = useState(false);
  const executionSequence = useRef(0),
    current = useRef(view);
  current.current = view;
  const disabled = pending || working || view.busy || !view.environment?.ready;
  const access = (name?: string) => projectEditAccess(view, name);
  const canEdit = (name: string) => !disabled && !!work?.canEdit && access(name).canEdit;
  const editor = useProjectEditor(
    view,
    (path) =>
      workbenchRequest<{ text: string; hash: string; changes?: FileChangeRange[] }>(
        `/api/pbl/v3?id=${encodeURIComponent(view.id)}&file=${encodeURIComponent(path)}`,
      ),
    onSave,
    setError,
    { enabled: !disabled && !!work?.canEdit, canEdit },
  );
  const { path, buffer, stale, savedNotice } = editor;
  const tabList = useRef<HTMLDivElement>(null);
  // Fade the strip's edge only where tabs continue, so hidden scrollbars still show there is more.
  const [tabOverflow, setTabOverflow] = useState({ start: false, end: false });
  useEffect(() => {
    const rail = tabList.current;
    if (!rail) return;
    const revealActiveTab = () => {
      const tab = rail.querySelector('[aria-selected="true"]')?.parentElement;
      if (!tab) return;
      const bounds = rail.getBoundingClientRect();
      const active = tab.getBoundingClientRect();
      if (active.left < bounds.left) rail.scrollLeft += active.left - bounds.left;
      else if (active.right > bounds.right) rail.scrollLeft += active.right - bounds.right;
    };
    const syncOverflow = () => {
      const start = rail.scrollLeft > 0;
      const end = rail.scrollLeft + rail.clientWidth < rail.scrollWidth - 1;
      setTabOverflow((current) =>
        current.start === start && current.end === end ? current : { start, end },
      );
    };
    revealActiveTab();
    syncOverflow();
    rail.addEventListener('scroll', syncOverflow, { passive: true });
    const observer = new ResizeObserver(() => {
      revealActiveTab();
      syncOverflow();
    });
    observer.observe(rail);
    return () => {
      rail.removeEventListener('scroll', syncOverflow);
      observer.disconnect();
    };
  }, [path, editor.tabs.length]);
  const selectedTarget = useRef<number | null>(null);
  const selectFile = useRef(editor.select);
  selectFile.current = editor.select;
  useEffect(() => {
    if (
      fileTarget &&
      selectedTarget.current !== fileTarget.requestId &&
      view.files.includes(fileTarget.path)
    ) {
      selectedTarget.current = fileTarget.requestId;
      selectFile.current(fileTarget.path);
    }
  }, [fileTarget, view.files]);
  const dirty = editor.anyDirty;
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  const editable = canEdit(path);
  const canSave =
    !disabled &&
    !editor.loading &&
    !editor.refreshing &&
    !editor.readError &&
    !stale &&
    !!buffer &&
    editable;
  const pendingReason =
    pendingAction === 'evaluate' || (pendingAction === 'collect' && view.stage.kind === 'check')
      ? 'testing'
      : pendingAction === 'compile' || pendingAction === 'collect'
        ? 'building'
        : ['chat', 'begin', 'retry'].includes(pendingAction ?? '')
          ? 'agent'
          : 'request';
  const editReason = view.completedFilesAvailable
    ? 'completed'
    : !view.environment?.ready
      ? 'environment'
      : stale
        ? 'stale'
        : operation
          ? 'operation'
          : pending
            ? pendingReason
            : (access(path).reason ??
              (editor.loading || editor.refreshing || !work ? 'loading' : null) ??
              work?.editReason ??
              (work?.canEdit ? (work.planning ? 'planEditable' : 'codeEditable') : 'loading'));
  const editMessage =
    editor.readError ||
    (editReason === 'environment'
      ? t(environmentNoticeKeys[environmentNotice(view.environment, pendingAction === 'prepare')])
      : t(`pblV3.editAccess.${editReason}`));
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
  useEffect(() => {
    executionSequence.current++;
    setTerminal('');
    setError('');
  }, [view.id, view.environmentId]);
  const run = async (action: string, payload: Record<string, unknown> = {}) => {
    // Stop invalidates earlier creation responses even when the provider finishes later.
    if (action === 'stop') executionSequence.current++;
    const executionTicket = executionSequence.current;
    const operationTicket = ++operationSequence.current;
    setOperation(action);
    if (action === 'terminal' || action === 'run') {
      setConsoleOpen(true);
      setConsoleTab(action === 'terminal' ? 'terminal' : 'output');
    }
    if (action === 'stop') setTerminal('');
    setError('');
    try {
      const selected = current.current;
      const result = await workbenchRequest<unknown>('/api/pbl/v3/workspace', {
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
      if (operationTicket === operationSequence.current) setOperation(null);
    }
  };
  const transport = useMemo(
    () => ({
      eventsUrl: `/api/pbl/v3/workspace/terminal?id=${encodeURIComponent(view.id)}&environmentId=${encodeURIComponent(view.environmentId ?? '')}&terminalId=${encodeURIComponent(terminal)}`,
      send: async (
        body: { action: 'input'; data: string } | { action: 'resize'; cols: number; rows: number },
      ) => {
        const latest = current.current;
        return workbenchRequest('/api/pbl/v3/workspace', {
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
      {(error || editor.readError) && (
        <div
          role="alert"
          className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-destructive/10 p-2 text-xs text-destructive"
        >
          <p className="min-w-0 flex-1">{error || editor.readError}</p>
          {editor.readError && (
            <button
              className={button}
              disabled={disabled || editor.loading || editor.refreshing || editor.saving}
              onClick={() => void editor.retryRead()}
            >
              <RefreshCw size={14} aria-hidden="true" />
              {t('pblV3.ide.retryRead')}
            </button>
          )}
        </div>
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
            groupResizeBehavior="preserve-pixel-size"
            panelRef={explorer}
            defaultSize="24%"
            minSize="15%"
            maxSize="45%"
            collapsible
            collapsedSize="0%"
            onResize={({ asPercentage }) => setFilesCollapsed(asPercentage === 0)}
            className="h-full bg-muted/20"
          >
            <header className="pbl-pane-header flex shrink-0 items-center gap-1 border-b pbl-chrome px-2">
              <Files size={15} className="shrink-0" aria-hidden="true" />
              <span className="mr-auto min-w-0 truncate text-xs font-semibold">
                {t('pblV3.files')}{' '}
                <span className="font-normal text-muted-foreground">{view.files.length}</span>
              </span>
              <button
                className={button}
                aria-label={t('pblV3.ide.hideFiles')}
                title={t('pblV3.ide.hideFiles')}
                onClick={() => explorer.current?.collapse()}
              >
                <ChevronLeft size={15} />
              </button>
            </header>
            <FileExplorer
              files={view.files}
              active={path}
              dirty={editor.dirty}
              editable={canEdit}
              onSelect={(p) => {
                editor.select(p);
              }}
            />
          </Panel>
          <Separator
            aria-label={t('pblV3.ide.resizeFiles')}
            className="w-px bg-border hover:bg-primary"
          />
          <Panel id="editor" minSize="45%" className="flex h-full min-w-0 flex-col">
            <div className="pbl-pane-header pbl-chrome flex shrink-0 items-center border-b">
              {filesCollapsed && (
                <button
                  className={button}
                  aria-label={t('pblV3.ide.toggleFiles')}
                  title={t('pblV3.ide.toggleFiles')}
                  onClick={() => explorer.current?.expand()}
                >
                  <PanelLeftOpen size={14} />
                </button>
              )}
              <div
                ref={tabList}
                role="tablist"
                aria-label={t('pblV3.ide.openFiles')}
                data-overflow-start={tabOverflow.start}
                data-overflow-end={tabOverflow.end}
                className="pbl-tab-strip flex h-full min-w-0 flex-1 flex-nowrap items-stretch overflow-x-auto overflow-y-hidden"
              >
                {editor.tabs.map((p) => {
                  const active = p === path;
                  return (
                    <div
                      key={p}
                      className={`group/tab flex max-w-[220px] shrink-0 items-center border-r border-t-2 ${
                        active ? 'border-t-primary bg-background' : 'border-t-transparent'
                      }`}
                    >
                      <button
                        role="tab"
                        aria-selected={active}
                        className="flex min-w-0 flex-1 items-center gap-1 px-3 py-1.5 text-left text-xs"
                        title={p}
                        onClick={() => {
                          editor.select(p);
                        }}
                      >
                        <span className="truncate whitespace-nowrap">{p.split('/').at(-1)}</span>
                        {editor.dirty(p) ? <span className="shrink-0"> ●</span> : null}
                      </button>
                      <button
                        className={`mr-1 shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 ${
                          active
                            ? 'opacity-100'
                            : 'opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100'
                        }`}
                        disabled={editor.saving}
                        aria-label={t('pblV3.ide.closeFile', { path: p })}
                        onClick={() => {
                          if (
                            !editor.dirty(p) ||
                            window.confirm(t('pblV3.ide.discard', { path: p }))
                          )
                            editor.close(p);
                        }}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  );
                })}
              </div>
              <div className="flex h-full shrink-0 items-center gap-0.5 border-l pl-1">
                {operation || editor.loading ? (
                  <PendingAction action={operation ?? 'read'} />
                ) : (
                  <span
                    role="status"
                    aria-live="polite"
                    className="flex shrink-0 items-center gap-1 px-1 text-xs text-muted-foreground"
                    title={editor.saveError || undefined}
                  >
                    {editor.saveError ? (
                      <>
                        <AlertCircle size={12} />
                        <button className="underline" disabled={!canSave} onClick={save}>
                          {t('pblV3.ide.saveFailed')}
                        </button>
                      </>
                    ) : editor.dirty(path) && !canSave && !editor.saving ? (
                      <span className="max-w-48 truncate whitespace-nowrap">
                        {t('pblV3.ide.draftRetained')}
                      </span>
                    ) : savedNotice ? (
                      <>
                        <Check size={12} className="text-emerald-600 dark:text-emerald-400" />
                        {t('pblV3.ide.saved')}
                      </>
                    ) : editor.saving || editor.dirty(path) ? (
                      <>
                        <LoaderCircle size={12} className="animate-spin" />
                        <span className="sr-only">{t('pblV3.ide.saving')}</span>
                      </>
                    ) : null}
                  </span>
                )}
                <button
                  className={button}
                  disabled={disabled || editor.saving}
                  onClick={reload}
                  aria-label={t(
                    editor.dirty(path) ? 'pblV3.workbench.discard' : 'pblV3.reloadFile',
                  )}
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
            </div>
            {!canSave && (
              <div
                role="status"
                aria-live="polite"
                data-testid="pbl-editor-readonly"
                className="flex shrink-0 items-start gap-2 border-b bg-amber-500/10 px-3 py-2 text-xs text-foreground"
              >
                <LockKeyhole size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                <p>
                  <strong>{t('pblV3.ide.readOnly')}: </strong>
                  {editMessage}
                </p>
              </div>
            )}
            {editor.recoveryConflict && (
              <div
                role="alert"
                className="flex items-center gap-2 border-b bg-amber-500/10 px-3 py-2 text-xs"
              >
                <p className="flex-1">{t('pblV3.ide.recoveryConflict')}</p>
                <button
                  className={button}
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(buffer?.text ?? '')
                      .catch((error) => setError((error as Error).message))
                  }
                >
                  {t('pblV3.ide.copyDraft')}
                </button>
              </div>
            )}
            <div className="relative min-h-0 flex-1">
              {buffer ? (
                <CodeEditor
                  key={path}
                  studyId={view.id}
                  path={path}
                  value={buffer.text}
                  onTargetConsumed={onFileTargetConsumed}
                  target={
                    !editor.loading && !stale && fileTarget?.path === path ? fileTarget : null
                  }
                  changes={!stale && buffer.text === buffer.saved ? buffer.changes : undefined}
                  readOnly={!canSave}
                  readOnlyReason={editMessage}
                  onChange={editor.edit}
                  onSave={save}
                />
              ) : (
                <p className="p-4 text-sm text-muted-foreground">
                  {t(view.environment?.ready ? 'pblV3.loading' : 'pblV3.environmentNotice')}
                </p>
              )}
            </div>
          </Panel>
        </Group>
      </div>
      {learningWorkbenchFeatures.executionConsole && (
        <div
          className="shrink-0 border-t bg-muted/10"
          style={{ height: consoleOpen ? '38%' : undefined }}
        >
          <div className="pbl-pane-header flex flex-wrap items-center gap-1 border-b px-2">
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
            {learningWorkbenchFeatures.executionConsole && (
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
            )}

            {learningWorkbenchFeatures.executionConsole && (
              <button
                className={`${button} ml-auto`}
                disabled={!view.environmentId || operation === 'stop'}
                onClick={() => void run('stop')}
              >
                <Square size={12} />
                {t('pblV3.workbench.stop')}
              </button>
            )}
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
              {learningWorkbenchFeatures.executionConsole && (
                <>
                  <p className="text-xs text-muted-foreground">
                    {t('pblV3.workbench.executionNotice')}
                  </p>
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
                </>
              )}
            </div>
            {learningWorkbenchFeatures.executionConsole && (
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
            )}
          </div>
        </div>
      )}
    </section>
  );
}
