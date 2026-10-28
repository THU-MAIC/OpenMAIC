'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { readEditorDraft, saveEditorDraft, type EditorBuffer } from './use-project-drafts';
import { getClientTranslation } from '@/lib/i18n';
import type { LearningView } from '@/lib/pbl/v3/types';
import { SandboxRequestError } from '@/components/sandbox/client';

export type FileSaveReceipt = { hash: string };
export type FileSaveRequest = { id: string; revision?: number };
const AUTOSAVE_DELAY_MS = 750;

/** Same debounce/serial receipt model as OpenPBL, with hosted file-hash fencing. */
export function useProjectEditor(
  view: LearningView,
  read: (path: string) => Promise<{ text: string; hash: string }>,
  onSave: (
    path: string,
    text: string,
    hash: string,
    request: FileSaveRequest,
  ) => Promise<FileSaveReceipt>,
  onError: (error: string) => void,
  options: { enabled: boolean; canEdit: (path: string) => boolean },
) {
  const [initial] = useState(() => readEditorDraft(view.id));
  const [path, setPath] = useState(initial.path);
  const [tabs, setTabs] = useState(initial.tabs.length ? initial.tabs : ['PLAN.md']);
  const [buffers, setBuffers] = useState<Record<string, EditorBuffer>>(initial.buffers);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const sequence = useRef(0),
    mounted = useRef(true);
  const inFlight = useRef<Promise<void> | null>(null),
    failed = useRef(false);
  const retrySave = useRef<{ name: string; buffer: EditorBuffer; request: FileSaveRequest } | null>(
    null,
  );
  const unavailableSave = useRef<{ name: string; environment: string } | null>(null);
  const current = useRef({ view, buffers, read, onError, onSave, path, options });
  current.current = { view, buffers, read, onError, onSave, path, options };
  const updateBuffers = useCallback(
    (update: (previous: Record<string, EditorBuffer>) => Record<string, EditorBuffer>) => {
      const next = update(current.current.buffers);
      current.current.buffers = next;
      setBuffers(next);
    },
    [],
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
    async (discard = false, name = current.current.path) => {
      const { view, read } = current.current;
      const path = name;
      if (!view.environment?.ready || !view.files.includes(path)) return;
      const active = path === current.current.path;
      const ticket = active ? ++sequence.current : sequence.current;
      if (active) setLoading(true);
      try {
        const result = await read(path);
        if (
          !mounted.current ||
          (active && ticket !== sequence.current) ||
          view.environmentId !== current.current.view.environmentId ||
          !current.current.view.files.includes(path)
        )
          return;
        const existing = current.current.buffers[path];
        // Server updates and Agent writes refresh clean documents; a late read never erases typing.
        if (!discard && existing && existing.text !== existing.saved) {
          const rejected = unavailableSave.current;
          const retry = retrySave.current;
          if (existing.environment === view.environmentId && rejected?.name !== path) return;
          const savedSubmission =
            result.text === existing.text ||
            (retry?.name === path &&
              retry.buffer.environment === existing.environment &&
              result.text === retry.buffer.text);
          // A replacement environment is not permission to rebase over another writer.
          // Reattach only a verified base or a submission observed in the restored file.
          if (result.hash !== existing.hash && !savedSubmission) return;
          updateBuffers((previous) => {
            const latest = previous[path];
            return latest?.environment === existing.environment && latest.hash === existing.hash
              ? {
                  ...previous,
                  [path]: {
                    ...latest,
                    saved: result.text,
                    hash: result.hash,
                    environment: view.environmentId!,
                  },
                }
              : previous;
          });
          if (
            (rejected?.name === path && rejected.environment === existing.environment) ||
            (retry?.name === path && retry.buffer.environment === existing.environment)
          ) {
            unavailableSave.current = null;
            retrySave.current = null;
            failed.current = false;
            setSaveError('');
          }
          return;
        }
        updateBuffers((previous) => ({
          ...previous,
          [path]: { ...result, saved: result.text, environment: view.environmentId! },
        }));
        if (
          discard ||
          (unavailableSave.current?.name === path &&
            unavailableSave.current.environment === existing?.environment)
        ) {
          failed.current = false;
          retrySave.current = null;
          unavailableSave.current = null;
          setSaveError('');
        }
      } catch (error) {
        current.current.onError((error as Error).message);
      } finally {
        if (active && ticket === sequence.current) setLoading(false);
      }
    },
    [updateBuffers],
  );
  useEffect(() => {
    const { buffers } = current.current;
    const buffer = buffers[path];
    if (
      !buffer ||
      buffer.text === buffer.saved ||
      buffer.environment !== view.environmentId ||
      unavailableSave.current?.name === path
    )
      void load();
    else setLoading(false);
    // Recovery must include background tabs; otherwise their retained drafts
    // would keep the study dirty even after the visible file resumed saving.
    for (const [name, buffer] of Object.entries(buffers))
      if (
        name !== path &&
        buffer.text !== buffer.saved &&
        (buffer.environment !== view.environmentId || unavailableSave.current?.name === name)
      )
        void load(false, name);
    return () => {
      // Invalidate the current read ticket rather than a captured one.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      sequence.current++;
    };
  }, [path, view.environmentId, view.environment?.ready, view.revision, load]);

  const pump = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    const run = async () => {
      while (mounted.current && !failed.current) {
        const { path: active, buffers, view, options, onSave } = current.current;
        if (!options.enabled) return;
        const retry = retrySave.current;
        if (
          retry &&
          (retry.buffer.environment !== view.environmentId ||
            !view.files.includes(retry.name) ||
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
              b.environment === view.environmentId &&
              view.files.includes(p) &&
              options.canEdit(p)
            );
          });
        if (!name) return;
        const buffer = retry?.buffer ?? buffers[name];
        const request = retry?.request ?? { id: crypto.randomUUID() };
        retrySave.current = { name, buffer, request };
        unavailableSave.current = null;
        setSaving(true);
        try {
          const receipt = await onSave(name, buffer.text, buffer.hash, request);
          retrySave.current = null;
          unavailableSave.current = null;
          // Acknowledgements update the submitted base, never the newer local value.
          const cached = readEditorDraft(view.id);
          const draft = cached.buffers[name];
          if (draft?.environment === buffer.environment && draft.hash === buffer.hash) {
            if (draft.text === buffer.text) delete cached.buffers[name];
            else cached.buffers[name] = { ...draft, saved: buffer.text, hash: receipt.hash };
            saveEditorDraft(view.id, cached);
          }
          if (!mounted.current) return;
          updateBuffers((previous) => {
            const existing = previous[name];
            return existing?.environment === buffer.environment && existing.hash === buffer.hash
              ? { ...previous, [name]: { ...existing, saved: buffer.text, hash: receipt.hash } }
              : previous;
          });
        } catch (error) {
          // A late outcome from the released workspace cannot freeze its replacement.
          if (buffer.environment !== current.current.view.environmentId) continue;
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
            retrySave.current = null;
            if (['ENVIRONMENT_UNAVAILABLE', 'ENVIRONMENT_CHANGED'].includes(error.reason ?? ''))
              unavailableSave.current = { name, environment: buffer.environment };
          }
          if (mounted.current) {
            failed.current = true;
            setSaveError((error as Error).message);
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
  }, [updateBuffers]);
  useEffect(() => {
    if (!options.enabled || failed.current) return;
    const timer = setTimeout(() => void pump(), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [buffers, options.enabled, view.environmentId, view.revision, pump]);
  const select = (name: string) => {
    if (name === path) return;
    sequence.current++;
    setTabs((previous) => (previous.includes(name) ? previous : [...previous, name]));
    setPath(name);
  };
  const close = (name: string) => {
    if (
      (retrySave.current?.name === name || unavailableSave.current?.name === name) &&
      !inFlight.current
    ) {
      retrySave.current = null;
      failed.current = false;
      unavailableSave.current = null;
      setSaveError('');
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
    const next = tabs.filter((p) => p !== name);
    if (!next.length) next.push('PLAN.md');
    setTabs(next);
    if (path === name) setPath(next.at(-1)!);
  };
  return {
    path,
    tabs,
    buffer: buffers[path],
    loading,
    saving,
    saveError,
    dirty,
    anyDirty: Object.values(buffers).some((b) => b.text !== b.saved),
    stale:
      !!buffers[path] &&
      (buffers[path].environment !== view.environmentId || !view.files.includes(path)),
    select,
    close,
    reload: () => load(true),
    save: () => {
      failed.current = false;
      setSaveError('');
      return pump();
    },
    edit: (text: string) => {
      const { path, view, options } = current.current;
      const b = current.current.buffers[path];
      if (
        !options.enabled ||
        !options.canEdit(path) ||
        !b ||
        b.environment !== view.environmentId ||
        b.text === text
      )
        return;
      // A failed write is retried explicitly; edits and server updates never loop a rejected command.
      updateBuffers((previous) => ({ ...previous, [path]: { ...previous[path], text } }));
    },
  };
}
