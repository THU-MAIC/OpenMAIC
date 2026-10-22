'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LearningView } from '@/lib/pbl/v3/types';

type Buffer = { text: string; saved: string; hash: string; environment: string };
export function useProjectEditor(
  view: LearningView,
  read: (path: string) => Promise<{ text: string; hash: string }>,
  onSave: (path: string, text: string, hash: string) => Promise<boolean>,
  onError: (error: string) => void,
) {
  const [path, setPath] = useState('PLAN.md');
  const [tabs, setTabs] = useState(['PLAN.md']);
  const [buffers, setBuffers] = useState<Record<string, Buffer>>({});
  const [loading, setLoading] = useState(false);
  const sequence = useRef(0);
  const current = useRef({ view, buffers, read, onError, onSave, path });
  current.current = { view, buffers, read, onError, onSave, path };
  const dirty = (name: string) => !!buffers[name] && buffers[name].text !== buffers[name].saved;
  const load = useCallback(async () => {
    const { view, path, read } = current.current;
    if (!view.environment?.ready || !view.files.includes(path)) return;
    const ticket = ++sequence.current;
    setLoading(true);
    try {
      const result = await read(path);
      if (
        ticket !== sequence.current ||
        view.environmentId !== current.current.view.environmentId ||
        path !== current.current.path
      )
        return;
      setBuffers((previous) => ({
        ...previous,
        [path]: { ...result, saved: result.text, environment: view.environmentId! },
      }));
    } catch (error) {
      current.current.onError((error as Error).message);
    } finally {
      if (ticket === sequence.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const buffer = current.current.buffers[path];
    if (!buffer || buffer.text === buffer.saved) void load();
    else setLoading(false);
    return () => {
      // Invalidate the latest request, not a DOM ref captured by this effect.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      sequence.current++;
    };
  }, [path, view.environmentId, view.environment?.ready, view.revision, load]);
  const select = (name: string) => {
    if (name === path) return;
    sequence.current++;
    setTabs((previous) => (previous.includes(name) ? previous : [...previous, name]));
    setPath(name);
  };
  const close = (name: string) => {
    if (tabs.length === 1 && name === 'PLAN.md') {
      void load();
      return;
    }
    if (name === path) {
      sequence.current++;
      setLoading(false);
    }
    setBuffers((previous) => {
      const next = { ...previous };
      delete next[name];
      return next;
    });
    const next = tabs.filter((p) => p !== name);
    if (!next.length) next.push('PLAN.md');
    setTabs(next);
    if (path === name) setPath(next.at(-1)!);
  };
  const save = async () => {
    const { path, buffers, view, onSave } = current.current;
    const buffer = buffers[path];
    if (!buffer || buffer.environment !== view.environmentId || !view.files.includes(path)) return;
    if (await onSave(path, buffer.text, buffer.hash)) {
      // A late save may mark this submitted version saved, never overwrite a newer local edit.
      setBuffers((previous) =>
        previous[path]
          ? { ...previous, [path]: { ...previous[path], saved: buffer.text } }
          : previous,
      );
      if (current.current.path === path && current.current.buffers[path]?.text === buffer.text)
        await load();
    }
  };
  return {
    path,
    tabs,
    buffer: buffers[path],
    loading,
    dirty,
    anyDirty: Object.values(buffers).some((b) => b.text !== b.saved),
    stale:
      !!buffers[path] &&
      (buffers[path].environment !== view.environmentId || !view.files.includes(path)),
    select,
    close,
    reload: load,
    save,
    edit: (text: string) =>
      setBuffers((previous) =>
        previous[path] ? { ...previous, [path]: { ...previous[path], text } } : previous,
      ),
  };
}
