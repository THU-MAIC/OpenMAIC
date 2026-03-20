'use client';

import { useState } from 'react';
import { QuizCategoryCard } from './quiz-category-card';
import { QuizConfigForm } from './quiz-config-form';
import { PlacementQuizConfig } from './placement-quiz-config';
import { CodingQuizConfig } from './coding-quiz-config';
import { QuizRunner } from './quiz-runner';
import { RecentHistory } from './recent-history';
import { WeakAreasTracker } from './weak-areas-tracker';
import { SuggestedNextQuiz } from './suggested-next-quiz';
import { getQuizHistory, getSuggestedNextQuiz, getWeakAreaSummary } from '@/lib/quiz/storage';
import type { CodingQuizSession, PlacementQuizSession, QuizTrack } from '@/lib/quiz/types';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import { useI18n } from '@/lib/hooks/use-i18n';

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

export function QuizDashboard() {
  const { locale } = useI18n();
  const [track, setTrack] = useState<QuizTrack | null>(null);
  const [loading, setLoading] = useState(false);
  const [placementCompany, setPlacementCompany] = useState('General');
  const [placementDifficulty, setPlacementDifficulty] = useState<'easy' | 'medium' | 'hard'>('medium');
  const [codingLanguage, setCodingLanguage] = useState<'python' | 'java' | 'cpp' | 'javascript'>('python');
  const [codingDifficulty, setCodingDifficulty] = useState<'easy' | 'medium' | 'hard'>('medium');
  const [session, setSession] = useState<PlacementQuizSession | CodingQuizSession | null>(null);
  const history = getQuizHistory();
  const weakAreas = getWeakAreaSummary();
  const suggested = getSuggestedNextQuiz();

  const startQuiz = async () => {
    if (!track) return;
    setLoading(true);
    try {
      const response = await fetch('/api/quiz/generate', {
        method: 'POST',
        headers: modelHeaders(),
        body: JSON.stringify(
          track === 'placement-aptitude'
            ? {
                track,
                company: placementCompany,
                difficulty: placementDifficulty,
                locale,
              }
            : {
                track,
                language: codingLanguage,
                difficulty: codingDifficulty,
              },
        ),
      });
      const data = await response.json();
      setSession(data.data || data);
    } finally {
      setLoading(false);
    }
  };

  if (session) {
    return <QuizRunner session={session} onBack={() => setSession(null)} />;
  }

  return (
    <div className="space-y-8">
      <div className="grid gap-4 md:grid-cols-2">
        <QuizCategoryCard
          title="Placement Preparation"
          description="TCS / Infosys / Wipro style aptitude sets with quant, logical reasoning, verbal, and DI."
          onClick={() => setTrack('placement-aptitude')}
        />
        <QuizCategoryCard
          title="Coding Examination"
          description="LeetCode-style timed coding round with DSA, debugging, complexity analysis, and code review."
          onClick={() => setTrack('coding-examination')}
        />
      </div>

      {track === 'placement-aptitude' ? (
        <QuizConfigForm
          title="Placement Aptitude"
          description="20 questions · 30 minute timer · AI debrief after submission"
          onStart={startQuiz}
          loading={loading}
        >
          <PlacementQuizConfig
            company={placementCompany}
            difficulty={placementDifficulty}
            onCompanyChange={setPlacementCompany}
            onDifficultyChange={setPlacementDifficulty}
          />
        </QuizConfigForm>
      ) : null}

      {track === 'coding-examination' ? (
        <QuizConfigForm
          title="Coding Examination"
          description="3 coding problems · 60 minute timer · AI review for each submission"
          onStart={startQuiz}
          loading={loading}
        >
          <CodingQuizConfig
            language={codingLanguage}
            difficulty={codingDifficulty}
            onLanguageChange={setCodingLanguage}
            onDifficultyChange={setCodingDifficulty}
          />
        </QuizConfigForm>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[1.3fr,1fr,1fr]">
        <RecentHistory items={history.slice(0, 6)} />
        <WeakAreasTracker items={weakAreas} />
        <SuggestedNextQuiz suggestion={suggested} />
      </div>
    </div>
  );
}
