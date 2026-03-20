'use client';

import type { CodingProblem } from '@/lib/quiz/types';
import { CodeEditor } from './code-editor';

export function CodeProblemCard({
  problem,
  language,
  code,
  onCodeChange,
}: {
  problem: CodingProblem;
  language: string;
  code: string;
  onCodeChange: (value: string) => void;
}) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-lg font-semibold">{problem.title}</h3>
        <span className="rounded-full bg-gray-100 px-3 py-1 text-xs capitalize dark:bg-gray-800">{problem.topic.replace(/-/g, ' ')}</span>
      </div>
      <p className="mt-3 whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-300">{problem.prompt}</p>
      {problem.constraints && problem.constraints.length > 0 && (
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          {problem.constraints.map((constraint) => (
            <li key={constraint}>{constraint}</li>
          ))}
        </ul>
      )}
      <div className="mt-4 space-y-3 text-sm">
        {problem.examples.map((example, index) => (
          <div key={index} className="rounded-xl bg-gray-50 p-3 dark:bg-gray-950/60">
            <p><strong>Input:</strong> {example.input}</p>
            <p><strong>Output:</strong> {example.output}</p>
            {example.explanation ? <p className="mt-1 text-muted-foreground">{example.explanation}</p> : null}
          </div>
        ))}
      </div>
      <div className="mt-4">
        <CodeEditor value={code} language={language} onChange={onCodeChange} />
      </div>
    </div>
  );
}
