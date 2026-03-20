'use client';

import { useState } from 'react';
import { InterviewConfigForm } from './interview-config-form';
import { InterviewHistory } from './interview-history';
import { InterviewSession } from './interview-session';
import { getInterviewHistory, saveInterviewHistory } from '@/lib/interview/storage';
import type { InterviewConfig, InterviewSessionSummary, InterviewTurn } from '@/lib/interview/types';
import { useI18n } from '@/lib/hooks/use-i18n';
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
  const history = getInterviewHistory();

  const startInterview = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/interview/session', {
        method: 'POST',
        headers: modelHeaders(),
        body: JSON.stringify({ ...config, language: locale }),
      });
      const data = await response.json();
      setOpeningQuestion((data.data || data).question || 'Tell me about yourself.');
    } finally {
      setLoading(false);
    }
  };

  const handleComplete = (summary: InterviewSessionSummary, _turns: InterviewTurn[]) => {
    saveInterviewHistory({
      id: crypto.randomUUID(),
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
        <InterviewConfigForm config={{ ...config, language: locale }} onChange={setConfig} onStart={startInterview} loading={loading} />
      )}
      <InterviewHistory items={history} />
    </div>
  );
}
