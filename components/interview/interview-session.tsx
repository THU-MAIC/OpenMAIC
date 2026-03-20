'use client';

import { useState } from 'react';
import { SpeechButton } from '@/components/audio/speech-button';
import type { InterviewConfig, InterviewSessionSummary, InterviewTurn } from '@/lib/interview/types';
import { InterviewChatPanel } from './interview-chat-panel';
import { InterviewFeedbackCard } from './interview-feedback-card';
import { InterviewSummary } from './interview-summary';
import { InterviewScoreBreakdown } from './interview-score-breakdown';
import { buildInterviewWhiteboardNotes } from '@/lib/interview/session';
import { getCurrentModelConfig } from '@/lib/utils/model-config';

function modelHeaders() {
  const modelConfig = getCurrentModelConfig();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-model': modelConfig.modelString,
    'x-api-key': modelConfig.apiKey,
  };
  if (modelConfig.baseUrl) headers['x-base-url'] = modelConfig.baseUrl;
  if (modelConfig.providerType) headers['x-provider-type'] = modelConfig.providerType;
  if (modelConfig.requiresApiKey) headers['x-requires-api-key'] = 'true';
  return headers;
}

export function InterviewSession({ config, openingQuestion, onComplete }: { config: InterviewConfig; openingQuestion: string; onComplete: (summary: InterviewSessionSummary, turns: InterviewTurn[]) => void }) {
  const [turns, setTurns] = useState<InterviewTurn[]>([{ id: crypto.randomUUID(), question: openingQuestion }]);
  const [answer, setAnswer] = useState('');
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState<InterviewSessionSummary | null>(null);

  const activeTurn = turns[turns.length - 1];
  const questionCount = turns.length;

  const submitAnswer = async () => {
    if (!answer.trim() || !activeTurn) return;
    setLoading(true);
    try {
      const history = turns.map((turn) => ({ question: turn.question, answer: turn.answer }));
      const response = await fetch('/api/interview/turn', {
        method: 'POST',
        headers: modelHeaders(),
        body: JSON.stringify({ config, history, answer }),
      });
      const data = await response.json();
      const payload = data.data || data;
      const updatedTurns = turns.map((turn) =>
        turn.id === activeTurn.id
          ? {
              ...turn,
              answer,
              feedback: payload.feedback,
            }
          : turn,
      );
      const nextTurns = payload.nextQuestion
        ? [...updatedTurns, { id: crypto.randomUUID(), question: payload.nextQuestion }]
        : updatedTurns;
      setTurns(nextTurns);
      setAnswer('');
    } finally {
      setLoading(false);
    }
  };

  const finishInterview = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/interview/debrief', {
        method: 'POST',
        headers: modelHeaders(),
        body: JSON.stringify({
          config,
          turns: turns.map((turn) => ({ question: turn.question, answer: turn.answer })),
        }),
      });
      const data = await response.json();
      const payload = data.data || data;
      setSummary(payload);
      onComplete(payload, turns);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="grid gap-5 xl:grid-cols-[1.2fr,0.8fr]">
        <InterviewChatPanel turns={turns} />
        <div className="space-y-5">
          <InterviewFeedbackCard turn={turns.find((turn) => turn.feedback && turn.id !== activeTurn?.id) || turns.at(-2)} />
          <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
            <h3 className="text-base font-semibold">Answer the current question</h3>
            <textarea
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              placeholder="Type or speak your answer..."
              className="mt-4 min-h-[140px] w-full rounded-xl border border-gray-200 bg-white p-3 text-sm dark:border-gray-700 dark:bg-gray-950"
            />
            <div className="mt-3 flex items-center justify-between gap-3">
              <SpeechButton size="md" onTranscription={(text) => setAnswer((current) => current + (current ? ' ' : '') + text)} />
              <div className="flex gap-3">
                <button onClick={finishInterview} disabled={loading} className="rounded-xl border border-gray-200 px-4 py-2 text-sm dark:border-gray-700">Finish</button>
                <button onClick={submitAnswer} disabled={loading || !answer.trim()} className="rounded-xl bg-violet-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">{loading ? 'Working...' : questionCount >= 6 ? 'Submit & Continue' : 'Submit Answer'}</button>
              </div>
            </div>
          </div>
          <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
            <h3 className="text-base font-semibold">Whiteboard Notes</h3>
            <ul className="mt-4 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {buildInterviewWhiteboardNotes(answer || activeTurn?.answer || '').map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {summary ? (
        <div className="grid gap-5 lg:grid-cols-[1.3fr,0.7fr]">
          <InterviewSummary summary={summary} />
          <InterviewScoreBreakdown
            communication={summary.communicationRating}
            technical={summary.technicalAccuracyRating}
          />
        </div>
      ) : null}
    </div>
  );
}
