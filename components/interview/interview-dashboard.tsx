'use client';

import { useState } from 'react';
import { InterviewConfigForm } from './interview-config-form';
import { InterviewHistory } from './interview-history';
import { InterviewSession } from './interview-session';
import { getInterviewHistory, saveInterviewHistory } from '@/lib/interview/storage';
import type { InterviewConfig, InterviewSessionSummary, InterviewTurn } from '@/lib/interview/types';
import { useI18n } from '@/lib/hooks/use-i18n';
import { getCurrentModelConfig } from '@/lib/utils/model-config';

function createId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `interview-history-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

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

export function InterviewDashboard() {
  const { locale } = useI18n();
  const [config, setConfig] = useState<InterviewConfig>({
    interviewType: 'both',
    role: 'software-engineer',
    difficulty: 'fresher',
    language: locale,
  });
  const [loading, setLoading] = useState(false);
  const [openingQuestion, setOpeningQuestion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const history = getInterviewHistory();

  const startInterview = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/interview/session', {
        method: 'POST',
        headers: modelHeaders(),
        body: JSON.stringify({ ...config, language: locale }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.message || data?.error?.message || 'Failed to start interview');
      }
      setOpeningQuestion((data.data || data).question || 'Tell me about yourself.');
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to start interview');
    } finally {
      setLoading(false);
    }
  };

  const handleComplete = (summary: InterviewSessionSummary, _turns: InterviewTurn[]) => {
    saveInterviewHistory({
      id: createId(),
      config: { ...config, language: locale },
      createdAt: Date.now(),
      summary,
    });
  };

  return (
    <div className="space-y-8">
      {openingQuestion ? (
        <InterviewSession config={{ ...config, language: locale }} openingQuestion={openingQuestion} onComplete={handleComplete} />
      ) : (
        <div className="space-y-3">
          {error ? (
            <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/20 dark:text-rose-300">
              {error}
            </p>
          ) : null}
          <InterviewConfigForm config={{ ...config, language: locale }} onChange={setConfig} onStart={startInterview} loading={loading} />
        </div>
      )}
      <InterviewHistory items={history} />
    </div>
  );
}
