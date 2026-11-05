'use client';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { editor as MonacoEditor } from 'monaco-editor';
import type { FileReference, FileChangeRange } from '@/lib/pbl/v3/file-reference';
import Editor, { loader } from '@monaco-editor/react';
import { useTheme } from '@/lib/hooks/use-theme';
import { useI18n } from '@/lib/hooks/use-i18n';

loader.config({ paths: { vs: '/code-editor/vs' } });

export function CodeEditor({
  studyId,
  path,
  value,
  target,
  changes,
  readOnly,
  readOnlyReason,
  onChange,
  onSave,
  onTargetConsumed,
}: {
  studyId: string;
  path: string;
  value: string;
  target?: (FileReference & { requestId: number }) | null;
  changes?: FileChangeRange[];
  readOnly: boolean;
  readOnlyReason: string;
  onChange: (text: string) => void;
  onSave: () => void;
  onTargetConsumed: (requestId: number) => void;
}) {
  const instance = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const decorations = useRef<MonacoEditor.IEditorDecorationsCollection | null>(null);
  const lastTarget = useRef<number | null>(null);
  const latest = useRef({ target, changes, onTargetConsumed });
  useLayoutEffect(() => {
    latest.current = { target, changes, onTargetConsumed };
  }, [target, changes, onTargetConsumed]);
  const present = useCallback(() => {
    const editor = instance.current,
      model = editor?.getModel();
    if (!editor || !model) return;
    const { target, changes } = latest.current;
    decorations.current?.set(
      (changes ?? []).map((change) => {
        const startLineNumber = Math.min(change.start, model.getLineCount());
        return {
          range: {
            startLineNumber,
            startColumn: 1,
            endLineNumber: Math.min(change.end, model.getLineCount()),
            endColumn: 1,
          },
          options: {
            isWholeLine: true,
            className: change.kind === 'deleted' ? undefined : `pbl-change-${change.kind}`,
            linesDecorationsClassName: `pbl-change-gutter-${change.kind}`,
            overviewRuler: {
              color: change.kind === 'deleted' ? '#ef4444' : '#22c55e',
              position: 1,
            },
          },
        };
      }),
    );
    if (target && lastTarget.current !== target.requestId) {
      lastTarget.current = target.requestId;
      const startLineNumber = Math.min(target.line ?? 1, model.getLineCount());
      const endLineNumber = Math.min(target.end ?? startLineNumber, model.getLineCount());
      const range = {
        startLineNumber,
        startColumn: 1,
        endLineNumber,
        endColumn: model.getLineMaxColumn(endLineNumber),
      };
      editor.setSelection(range);
      editor.revealRangeInCenter(range);
      editor.focus();
      latest.current.onTargetConsumed(target.requestId);
    }
  }, []);
  useEffect(() => {
    present();
  }, [target, changes, present]);
  const change = useRef({ readOnly, onChange });
  // Update before Monaco synchronizes controlled values in passive effects.
  useLayoutEffect(() => {
    change.current = { readOnly, onChange };
  }, [readOnly, onChange]);
  const handleChange = useCallback((text: string | undefined) => {
    // Read-only setValue emits Monaco changes too; only user-editable values are edits.
    if (!change.current.readOnly) change.current.onChange(text ?? '');
  }, []);
  const save = useRef(onSave);
  useEffect(() => {
    save.current = onSave;
  }, [onSave]);
  const { resolvedTheme } = useTheme();
  const { t } = useI18n();
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  const language =
    (
      {
        py: 'python',
        java: 'java',
        js: 'javascript',
        ts: 'typescript',
        tsx: 'typescript',
        jsx: 'javascript',
        json: 'json',
        md: 'markdown',
        html: 'html',
        css: 'css',
        yml: 'yaml',
        yaml: 'yaml',
        sh: 'shell',
        c: 'c',
        cpp: 'cpp',
      } as Record<string, string>
    )[extension] ?? 'plaintext';
  return (
    <Editor
      key={`${studyId}/${path}`}
      height="100%"
      width="100%"
      path={`${studyId}/${path}`}
      language={language}
      value={value}
      theme={resolvedTheme === 'dark' ? 'vs-dark' : 'light'}
      loading={<p className="p-4 text-sm text-muted-foreground">{t('pblV3.loading')}</p>}
      onChange={handleChange}
      onMount={(editor, monaco) => {
        instance.current = editor;
        decorations.current = editor.createDecorationsCollection();
        present();
        // The native readonly textarea suppresses character/paste input events.
        // Route those attempts through Monaco so its cursor-side message still appears.
        const attempt = editor.onKeyDown(({ browserEvent: event }) => {
          if (!editor.getOption(monaco.editor.EditorOption.readOnly)) return;
          const command = event.metaKey || event.ctrlKey;
          const typing = event.key.length === 1 && !command && !event.altKey;
          const clipboard = command && ['v', 'x'].includes(event.key.toLowerCase());
          if (typing || clipboard || event.isComposing || event.key === 'Process')
            editor.trigger('readonly-keyboard', 'type', { text: event.key });
        });
        editor.onDidDispose(() => attempt.dispose());
        editor.addAction({
          id: 'pbl-save-file',
          label: t('pblV3.saveFile'),
          keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
          run: () => save.current(),
        });
      }}
      options={{
        readOnly,
        readOnlyMessage: { value: readOnlyReason },
        domReadOnly: readOnly,
        ariaLabel: t('pblV3.editor'),
        automaticLayout: true,
        fixedOverflowWidgets: true,
        minimap: { enabled: false },
        fontSize: 13,
        lineHeight: 21,
        padding: { top: 12 },
        scrollBeyondLastLine: false,
        tabSize: 4,
        wordWrap: 'on',
        // Keep native textarea input consistent across browsers and classroom keyboard handling.
        editContext: false,
        accessibilitySupport: 'on',
      }}
    />
  );
}
