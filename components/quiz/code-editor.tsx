'use client';

import dynamic from 'next/dynamic';

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false });

export function CodeEditor({ value, language, onChange }: { value: string; language: string; onChange: (value: string) => void }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-gray-200 dark:border-gray-800">
      <MonacoEditor
        height="320px"
        language={language === 'cpp' ? 'cpp' : language}
        theme="vs-dark"
        value={value}
        onChange={(next) => onChange(next || '')}
        options={{ minimap: { enabled: false }, fontSize: 14, wordWrap: 'on' }}
      />
    </div>
  );
}
