'use client';
import type { FileChangeRange } from '@/lib/pbl/v3/file-reference';
import { useCallback, useEffect, useRef, useState } from 'react';
import { readEditorDraft, saveEditorDraft, type EditorBuffer } from './use-project-drafts';
import { getClientTranslation } from '@/lib/i18n';
import type { LearningView } from '@/lib/pbl/v3/types';
import { SandboxRequestError } from '@/components/sandbox/client';

export type FileSaveReceipt = { hash: string };
export type FileSaveRequest = { id: string; revision?: number };
const AUTOSAVE_DELAY_MS = 750;

const editorSource = (view: LearningView) =>
  view.completedFilesAvailable ? `completed:${view.id}:${view.revision}` : view.environmentId;

/** Same debounce/serial receipt model as OpenPBL, with hosted file-hash fencing. */
export function useProjectEditor(
  view: LearningView,
  read: (path: string) => Promise<{ text: string; hash: string; changes?: FileChangeRange[] }>,
  onSave: (
    path: string,
    text: string,
    hash: string,
    request: FileSaveRequest,
  ) => Promise<FileSaveReceipt>,
  onError: (error: string) => void,
  options: { enabled: boolean; canEdit: (path: string) => boolean },
) {
  const selectedSource = editorSource(view);
  const [initial] = useState(() => readEditorDraft(view.id));
  const [path, setPath] = useState(initial.path);
  const [tabs, setTabs] = useState(initial.tabs.length ? initial.tabs : ['PLAN.md']);
  const [buffers, setBuffers] = useState<Record<string, EditorBuffer>>(initial.buffers);
  const [loading, setLoading] = useState(false);
  // Keep cached content visible, but do not accept edits until its fresh read succeeds.
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailures, setSaveFailures] = useState<{
    pausedFile: string | null;
    errors: Record<string, string>;
  }>({ pausedFile: null, errors: {} });
  const [readErrors, setReadErrors] = useState<
    Record<string, { source: ReturnType<typeof editorSource>; message: string }>
  >({});
  const readTickets = useRef(new Map<string, number>());
  // Only display verified buffers during background refreshes. Persisted drafts
  // and changed sources/revisions still require their normal recovery read.
  const verifiedReads = useRef(new Map<string, { source: string | null; revision: number }>());
  const [recoveryConflicts, setRecoveryConflicts] = useState<Record<string, string>>({});
  const sequence = useRef(0),
    mounted = useRef(true);
  const inFlight = useRef<Promise<void> | null>(null);
  const retrySaves = useRef(
    new Map<string, { name: string; buffer: EditorBuffer; request: FileSaveRequest }>(),
  );
  const unavailableSave = useRef<{ name: string; environment: string } | null>(null);
  const current = useRef({
    view,
    buffers,
    read,
    onError,
    onSave,
    path,
    options,
    recoveryConflicts,
    refreshing,
    readErrors,
    saveFailures,
  });
  current.current = {
    view,
    buffers,
    read,
    onError,
    onSave,
    path,
    options,
    recoveryConflicts,
    refreshing,
    readErrors,
    saveFailures,
  };
  const updateBuffers = useCallback(
    (update: (previous: Record<string, EditorBuffer>) => Record<string, EditorBuffer>) => {
      const next = update(current.current.buffers);
      current.current.buffers = next;
      setBuffers(next);
    },
    [],
  );
  const updateReadErrors = useCallback(
    (update: (previous: typeof readErrors) => typeof readErrors) => {
      // A save receipt can drain the next draft before React renders the failed read.
      const next = update(current.current.readErrors);
      current.current.readErrors = next;
      setReadErrors(next);
    },
    [],
  );
  const updateSaveFailures = useCallback(
    (update: (previous: typeof saveFailures) => typeof saveFailures) => {
      // Retrying one file never authorizes another file's failed submission.
      const next = update(current.current.saveFailures);
      current.current.saveFailures = next;
      setSaveFailures(next);
    },
    [],
  );
  const clearSaveFailure = useCallback(
    (name: string, resumeQueue = false) =>
      updateSaveFailures((previous) => {
        const hasError = Object.hasOwn(previous.errors, name);
        const pausedFile = resumeQueue || previous.pausedFile === name ? null : previous.pausedFile;
        if (!hasError && pausedFile === previous.pausedFile) return previous;
        const errors = hasError ? { ...previous.errors } : previous.errors;
        if (hasError) delete errors[name];
        return { pausedFile, errors };
      }),
    [updateSaveFailures],
  );
  const updateRecoveryConflicts = useCallback(
    (update: (previous: typeof recoveryConflicts) => typeof recoveryConflicts) => {
      // The queue must see a conflict before another file's receipt can drain it.
      const next = update(current.current.recoveryConflicts);
      current.current.recoveryConflicts = next;
      setRecoveryConflicts(next);
    },
    [],
  );
  const clearFileFailure = useCallback(
    (name: string) => {
      retrySaves.current.delete(name);
      if (unavailableSave.current?.name === name) unavailableSave.current = null;
      // Recovering one file must not authorize retrying another failed write.
      clearSaveFailure(name);
    },
    [clearSaveFailure],
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Invalidate the current read ticket rather than a captured one.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      sequence.current++;
    };
  }, []);
  useEffect(() => {
    if (!saveEditorDraft(view.id, { path, tabs, buffers }))
      onError(getClientTranslation('pblV3.draftStorageUnavailable'));
  }, [view.id, path, tabs, buffers, onError]);
  const dirty = (name: string) => !!buffers[name] && buffers[name].text !== buffers[name].saved;
  const load = useCallback(
    async (discard = false, name = current.current.path, background = false) => {
      const { view, read } = current.current;
      const path = name;
      if ((!view.environment?.ready && !view.completedFilesAvailable) || !view.files.includes(path))
        return;
      const active = path === current.current.path;
      const ticket = active ? ++sequence.current : sequence.current;
      const source = editorSource(view);
      const baseHash = current.current.buffers[path]?.hash;
      const readTicket = (readTickets.current.get(path) ?? 0) + 1;
      readTickets.current.set(path, readTicket);
      const isCurrent = () =>
        mounted.current &&
        (!active || ticket === sequence.current) &&
        readTickets.current.get(path) === readTicket &&
        view.id === current.current.view.id &&
        source === editorSource(current.current.view) &&
        current.current.view.files.includes(path);
      if (active) {
        setLoading(!background);
        setRefreshing(background);
      }
      try {
        const result = await read(path);
        if (!isCurrent()) return;
        // A save can finish while a non-blocking read is in flight. Its newer
        // acknowledged base wins over that read, even if typing is now clean.
        if (background && current.current.buffers[path]?.hash !== baseHash) return;
        const retryingRead = current.current.readErrors[path]?.source === source;
        verifiedReads.current.delete(path);
        updateReadErrors((previous) => {
          if (previous[path]?.source !== source) return previous;
          const next = { ...previous };
          delete next[path];
          return next;
        });
        const existing = current.current.buffers[path];
        const clearRecoveredFailure = () => {
          const rejected = unavailableSave.current,
            retry = retrySaves.current.get(path);
          if (
            (rejected?.name === path && rejected.environment === existing?.environment) ||
            (retry?.name === path && retry.buffer.environment === existing?.environment)
          ) {
            clearFileFailure(path);
          }
        };
        const clearConflict = () =>
          updateRecoveryConflicts((previous) => {
            if (!previous[path]) return previous;
            const next = { ...previous };
            delete next[path];
            return next;
          });
        // Server updates and Agent writes refresh clean documents; a late read never erases typing.
        if (!discard && existing && existing.text !== existing.saved) {
          const rejected = unavailableSave.current;
          const retry = retrySaves.current.get(path);
          if (
            existing.environment === editorSource(view) &&
            rejected?.name !== path &&
            !retryingRead
          )
            return;
          const savedSubmission =
            result.text === existing.text ||
            (retry?.name === path &&
              retry.buffer.environment === existing.environment &&
              result.text === retry.buffer.text);
          // A replacement environment is not permission to rebase over another writer.
          // Reattach only a verified base or a submission observed in the restored file.
          if (result.hash !== existing.hash && !savedSubmission) {
            updateRecoveryConflicts((previous) =>
              previous[path] === editorSource(view)
                ? previous
                : { ...previous, [path]: editorSource(view)! },
            );
            if (existing.environment !== editorSource(view)) clearRecoveredFailure();
            return;
          }
          clearConflict();
          updateBuffers((previous) => {
            const latest = previous[path];
            return latest?.environment === existing.environment && latest.hash === existing.hash
              ? {
                  ...previous,
                  [path]: {
                    ...latest,
                    saved: result.text,
                    hash: result.hash,
                    changes: result.changes,
                    environment: editorSource(view)!,
                  },
                }
              : previous;
          });
          // A successful read of the old base does not acknowledge an uncertain write.
          if (existing.environment !== source || rejected?.name === path || savedSubmission)
            clearRecoveredFailure();
          return;
        }
        clearConflict();
        verifiedReads.current.set(path, { source, revision: view.revision });
        updateBuffers((previous) => ({
          ...previous,
          [path]: { ...result, saved: result.text, environment: editorSource(view)! },
        }));
        if (
          discard ||
          (unavailableSave.current?.name === path &&
            unavailableSave.current.environment === existing?.environment)
        ) {
          clearFileFailure(path);
        }
      } catch (error) {
        if (isCurrent()) {
          verifiedReads.current.delete(path);
          updateReadErrors((previous) => ({
            ...previous,
            [path]: { source, message: (error as Error).message },
          }));
        }
      } finally {
        if (active && ticket === sequence.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [updateBuffers, updateReadErrors, updateRecoveryConflicts, clearFileFailure],
  );
  useEffect(() => {
    const { buffers } = current.current;
    if (!view.environment?.ready && !view.completedFilesAvailable) verifiedReads.current.clear();
    const buffer = buffers[path];
    const verified = verifiedReads.current.get(path);
    const reusable =
      buffer?.environment === selectedSource &&
      verified?.source === selectedSource &&
      verified?.revision === view.revision;
    if (
      !buffer ||
      buffer.text === buffer.saved ||
      buffer.environment !== selectedSource ||
      unavailableSave.current?.name === path
    )
      // Shell writes need not advance the study revision. Keep revalidating
      // clean files, but do not block a tab switch on an already verified read.
      void load(false, path, reusable && unavailableSave.current?.name !== path);
    else {
      setLoading(false);
      setRefreshing(false);
    }
    // Recovery must include background tabs; otherwise their retained drafts
    // would keep the study dirty even after the visible file resumed saving.
    for (const [name, buffer] of Object.entries(buffers))
      if (
        name !== path &&
        buffer.text !== buffer.saved &&
        (buffer.environment !== selectedSource || unavailableSave.current?.name === name)
      )
        void load(false, name);
    return () => {
      // Invalidate the current read ticket rather than a captured one.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      sequence.current++;
    };
  }, [
    path,
    selectedSource,
    view.completedFilesAvailable,
    view.environment?.ready,
    view.revision,
    load,
  ]);

  const pump = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    const run = async () => {
      while (mounted.current && !current.current.saveFailures.pausedFile) {
        const {
          path: active,
          buffers,
          view,
          options,
          onSave,
          recoveryConflicts,
          readErrors,
          saveFailures,
        } = current.current;
        if (!options.enabled) return;
        // Keep each uncertain submission intact while another file can save.
        const retry = Array.from(retrySaves.current.values()).find(
          (entry) =>
            !Object.hasOwn(saveFailures.errors, entry.name) &&
            readErrors[entry.name]?.source !== editorSource(view) &&
            recoveryConflicts[entry.name] !== editorSource(view),
        );
        if (
          retry &&
          (retry.buffer.environment !== editorSource(view) ||
            !view.files.includes(retry.name) ||
            recoveryConflicts[retry.name] === editorSource(view) ||
            !options.canEdit(retry.name))
        )
          return;
        const name =
          retry?.name ??
          [active, ...Object.keys(buffers).filter((p) => p !== active)].find((p) => {
            const b = buffers[p];
            return (
              b &&
              b.text !== b.saved &&
              !Object.hasOwn(saveFailures.errors, p) &&
              b.environment === editorSource(view) &&
              recoveryConflicts[p] !== editorSource(view) &&
              readErrors[p]?.source !== editorSource(view) &&
              view.files.includes(p) &&
              options.canEdit(p)
            );
          });
        if (!name) return;
        const buffer = retry?.buffer ?? buffers[name];
        const request = retry?.request ?? { id: crypto.randomUUID() };
        retrySaves.current.set(name, { name, buffer, request });
        unavailableSave.current = null;
        setSaving(true);
        try {
          const receipt = await onSave(name, buffer.text, buffer.hash, request);
          retrySaves.current.delete(name);
          unavailableSave.current = null;
          // Acknowledgements update the submitted base, never the newer local value.
          const cached = readEditorDraft(view.id);
          const draft = cached.buffers[name];
          if (draft?.environment === buffer.environment && draft.hash === buffer.hash) {
            if (draft.text === buffer.text) delete cached.buffers[name];
            else
              cached.buffers[name] = {
                ...draft,
                saved: buffer.text,
                hash: receipt.hash,
                changes: undefined,
              };
            saveEditorDraft(view.id, cached);
          }
          if (!mounted.current) return;
          updateBuffers((previous) => {
            const existing = previous[name];
            return existing?.environment === buffer.environment && existing.hash === buffer.hash
              ? {
                  ...previous,
                  [name]: {
                    ...existing,
                    saved: buffer.text,
                    hash: receipt.hash,
                    changes: undefined,
                  },
                }
              : previous;
          });
        } catch (error) {
          // A late outcome from the released workspace cannot freeze its replacement.
          if (buffer.environment !== editorSource(current.current.view)) continue;
          // A confirmed precondition rejection did not write this draft. Unknown outcomes
          // still replay the exact request; fresh attempts retain the observed file hash.
          if (
            error instanceof SandboxRequestError &&
            error.status === 409 &&
            [
              'PROGRESS_CHANGED',
              'WORKSPACE_FILE_CONFLICT',
              'ENVIRONMENT_UNAVAILABLE',
              'ENVIRONMENT_CHANGED',
            ].includes(error.reason ?? '')
          ) {
            retrySaves.current.delete(name);
            if (['ENVIRONMENT_UNAVAILABLE', 'ENVIRONMENT_CHANGED'].includes(error.reason ?? ''))
              unavailableSave.current = { name, environment: buffer.environment };
          }
          if (mounted.current) {
            updateSaveFailures((previous) => ({
              pausedFile: name,
              errors: { ...previous.errors, [name]: (error as Error).message },
            }));
          }
          return;
        }
      }
    };
    inFlight.current = run().finally(() => {
      inFlight.current = null;
      if (mounted.current) setSaving(false);
    });
    return inFlight.current;
  }, [updateBuffers, updateSaveFailures]);
  useEffect(() => {
    if (!options.enabled || current.current.saveFailures.pausedFile) return;
    const timer = setTimeout(() => void pump(), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [
    buffers,
    readErrors,
    saveFailures,
    options.enabled,
    view.environmentId,
    view.completedFilesAvailable,
    view.revision,
    pump,
  ]);
  const select = (name: string) => {
    if (name === path) return;
    sequence.current++;
    setTabs((previous) => (previous.includes(name) ? previous : [...previous, name]));
    setPath(name);
  };
  const close = (name: string) => {
    if (
      (retrySaves.current.has(name) ||
        unavailableSave.current?.name === name ||
        Object.hasOwn(current.current.saveFailures.errors, name)) &&
      !inFlight.current
    ) {
      clearFileFailure(name);
    }
    if (tabs.length === 1 && name === 'PLAN.md') {
      void load(true);
      return;
    }
    if (name === path) {
      sequence.current++;
      setLoading(false);
    }
    updateBuffers((previous) => {
      const next = { ...previous };
      delete next[name];
      return next;
    });
    verifiedReads.current.delete(name);
    const next = tabs.filter((p) => p !== name);
    if (!next.length) next.push('PLAN.md');
    setTabs(next);
    if (path === name) setPath(next.at(-1)!);
  };
  const saveErrorFor = (name: string) =>
    Object.hasOwn(saveFailures.errors, name) ? saveFailures.errors[name] : undefined;
  return {
    path,
    tabs,
    buffer: buffers[path],
    loading,
    refreshing,
    saving,
    // While the queue is paused, keep its Retry entry point visible on healthy tabs.
    saveError:
      saveErrorFor(path) ??
      (saveFailures.pausedFile ? saveErrorFor(saveFailures.pausedFile) : '') ??
      '',
    readError: readErrors[path]?.source === selectedSource ? readErrors[path].message : '',
    recoveryConflict: recoveryConflicts[path] === editorSource(view),
    dirty,
    anyDirty: Object.values(buffers).some((b) => b.text !== b.saved),
    hasReadBlockedDraft: Object.entries(buffers).some(
      ([name, buffer]) =>
        buffer.text !== buffer.saved &&
        buffer.environment === selectedSource &&
        readErrors[name]?.source === selectedSource,
    ),
    stale:
      !!buffers[path] &&
      (buffers[path].environment !== editorSource(view) ||
        !view.files.includes(path) ||
        recoveryConflicts[path] === editorSource(view)),
    select,
    close,
    reload: () => load(true),
    retryRead: () => load(),
    save: () => {
      clearSaveFailure(current.current.path, true);
      return pump();
    },
    edit: (text: string) => {
      const { path, view, options, recoveryConflicts, readErrors } = current.current;
      const b = current.current.buffers[path];
      if (
        current.current.refreshing ||
        !options.enabled ||
        !options.canEdit(path) ||
        !b ||
        b.environment !== editorSource(view) ||
        recoveryConflicts[path] === editorSource(view) ||
        readErrors[path]?.source === editorSource(view) ||
        b.text === text
      )
        return;
      // A failed write is retried explicitly; edits and server updates never loop a rejected command.
      updateBuffers((previous) => ({ ...previous, [path]: { ...previous[path], text } }));
    },
  };
}
