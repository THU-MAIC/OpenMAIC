'use client';

import { useMemo, useState } from 'react';
import type { CodeReviewResult, CodingQuizSession, PlacementQuizSession } from '@/lib/quiz/types';
import { QuizTimer } from './quiz-timer';
import { scorePlacementQuiz, estimatePercentile } from '@/lib/quiz/scoring';
import { saveQuizHistoryItem } from '@/lib/quiz/storage';
import { CodeProblemCard } from './code-problem-card';
import { QuizResults } from './quiz-results';
import { CodeReviewPanel } from './code-review-panel';
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

export function QuizRunner({ session, onBack }: { session: PlacementQuizSession | CodingQuizSession; onBack: () => void }) {
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [placementAnswers, setPlacementAnswers] = useState<Record<string, string>>({});
  const [codeAnswers, setCodeAnswers] = useState<Record<string, string>>(
    session.track === 'coding-examination'
      ? Object.fromEntries(session.problems.map((problem) => [problem.id, problem.starterCode || '']))
      : {},
  );
  const [debrief, setDebrief] = useState<{ summary?: string; percentileEstimate?: string }>({});
  const [codeReviews, setCodeReviews] = useState<Array<{ id: string; title: string; review: CodeReviewResult }>>([]);

  const placementScore = useMemo(() => {
    if (session.track !== 'placement-aptitude') return null;
    return scorePlacementQuiz(session.questions, placementAnswers);
  }, [placementAnswers, session]);

  const handleSubmit = async () => {
    if (submitted) return;
    setLoading(true);
    try {
      if (session.track === 'placement-aptitude') {
        const score = scorePlacementQuiz(session.questions, placementAnswers);
        const summary = `Score: ${score.score}/${score.total}. Weak areas: ${score.weakAreas.join(', ') || 'None'}.`;
        const response = await fetch('/api/quiz/debrief', {
          method: 'POST',
          headers: modelHeaders(),
          body: JSON.stringify({ summary }),
        });
        const data = await response.json();
        const debriefData = data.data || data;
        setDebrief({
          summary: debriefData.summary || 'Review arithmetic speed, accuracy, and elimination strategies.',
          percentileEstimate: debriefData.percentileEstimate || estimatePercentile(score.percentage),
        });
        saveQuizHistoryItem({
          id: crypto.randomUUID(),
          track: session.track,
          title: session.title,
          score: score.score,
          total: score.total,
          percentage: score.percentage,
          weakAreas: score.weakAreas,
          createdAt: Date.now(),
          metadata: { company: session.company, difficulty: session.difficulty },
        });
      } else {
        const reviews = await Promise.all(
          session.problems.map(async (problem) => {
            const response = await fetch('/api/quiz/review-code', {
              method: 'POST',
              headers: modelHeaders(),
              body: JSON.stringify({
                title: problem.title,
                prompt: problem.prompt,
                code: codeAnswers[problem.id] || '',
                language: session.language,
              }),
            });
            const data = await response.json();
            return { id: problem.id, title: problem.title, review: data.data || data };
          }),
        );
        setCodeReviews(reviews);
        const weakAreas = session.problems.map((problem) => problem.topic);
        saveQuizHistoryItem({
          id: crypto.randomUUID(),
          track: session.track,
          title: session.title,
          score: reviews.length,
          total: session.problems.length,
          percentage: 100,
          weakAreas,
          createdAt: Date.now(),
          metadata: { language: session.language, difficulty: session.difficulty },
        });
        setDebrief({
          summary: 'AI review completed. Focus on writing cleaner edge-case handling, stronger complexity explanations, and a more systematic optimal approach.',
          percentileEstimate: 'Interview-style qualitative review',
        });
      }
      setSubmitted(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-xl font-semibold">{session.title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {session.track === 'placement-aptitude'
              ? `${session.company} style · ${session.questions.length} questions`
              : `${session.language.toUpperCase()} · ${session.problems.length} coding problems`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <QuizTimer durationMinutes={session.durationMinutes} onExpire={handleSubmit} running={!submitted} />
          <button onClick={onBack} className="rounded-xl border border-gray-200 px-4 py-2 text-sm dark:border-gray-700">Back</button>
          <button onClick={handleSubmit} disabled={loading} className="rounded-xl bg-violet-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">{loading ? 'Submitting...' : 'Submit'}</button>
        </div>
      </div>

      {session.track === 'placement-aptitude' && !submitted ? (
        <div className="space-y-4">
          {session.questions.map((question, index) => (
            <div key={question.id} className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
              <p className="text-sm font-semibold">Q{index + 1}. {question.question}</p>
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {question.options.map((option) => (
                  <button
                    key={option.id}
                    onClick={() => setPlacementAnswers((prev) => ({ ...prev, [question.id]: option.id }))}
                    className={`rounded-xl border px-4 py-3 text-left text-sm ${placementAnswers[question.id] === option.id ? 'border-violet-500 bg-violet-50 dark:bg-violet-950/30' : 'border-gray-200 dark:border-gray-700'}`}
                  >
                    <span className="font-medium">{option.id}.</span> {option.text}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {session.track === 'coding-examination' && !submitted ? (
        <div className="space-y-4">
          {session.problems.map((problem) => (
            <CodeProblemCard
              key={problem.id}
              problem={problem}
              language={session.language}
              code={codeAnswers[problem.id] || ''}
              onCodeChange={(value) => setCodeAnswers((prev) => ({ ...prev, [problem.id]: value }))}
            />
          ))}
        </div>
      ) : null}

      {submitted && session.track === 'placement-aptitude' && placementScore ? (
        <QuizResults title="Placement Aptitude" score={placementScore.score} total={placementScore.total} debrief={debrief}>
          <div className="space-y-4">
            {session.questions.map((question) => {
              const selected = placementAnswers[question.id];
              const correct = selected === question.correctAnswer;
              return (
                <div key={question.id} className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
                  <p className="font-medium">{question.question}</p>
                  <p className="mt-2 text-sm">Your answer: <strong>{selected || '—'}</strong></p>
                  <p className="text-sm">Correct answer: <strong>{question.correctAnswer}</strong></p>
                  {!correct ? <p className="mt-2 text-sm text-muted-foreground">{question.explanation}</p> : null}
                </div>
              );
            })}
          </div>
        </QuizResults>
      ) : null}

      {submitted && session.track === 'coding-examination' ? (
        <QuizResults title="Coding Examination" score={codeReviews.length} total={session.problems.length} debrief={debrief}>
          <CodeReviewPanel reviews={codeReviews} />
        </QuizResults>
      ) : null}
    </div>
  );
}
