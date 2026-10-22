'use client';
import { useEffect, useRef } from 'react';
import Editor, { loader } from '@monaco-editor/react';
import { useTheme } from '@/lib/hooks/use-theme';
import { useI18n } from '@/lib/hooks/use-i18n';

loader.config({ paths: { vs: '/code-editor/vs' } });

export function CodeEditor({
  studyId,
  path,
  value,
  readOnly,
  onChange,
  onSave,
}: {
  studyId: string;
  path: string;
  value: string;
  readOnly: boolean;
  onChange: (text: string) => void;
  onSave: () => void;
}) {
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
      height="100%"
      width="100%"
      path={`${studyId}/${path}`}
      language={language}
      value={value}
      theme={resolvedTheme === 'dark' ? 'vs-dark' : 'light'}
      loading={<p className="p-4 text-sm text-muted-foreground">{t('pblV3.loading')}</p>}
      onChange={(text) => onChange(text ?? '')}
      onMount={(editor, monaco) => {
        editor.addAction({
          id: 'pbl-save-file',
          label: t('pblV3.saveFile'),
          keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
          run: () => save.current(),
        });
      }}
      options={{
        readOnly,
        domReadOnly: readOnly,
        ariaLabel: t('pblV3.editor'),
        automaticLayout: true,
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
