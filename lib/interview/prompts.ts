import type { InterviewConfig } from './types';

export function buildInterviewSessionPrompt(config: InterviewConfig) {
  return `You are a natural AI interviewer. Create the opening interview question only.
Interview type: ${config.interviewType}
Role: ${config.role}
Difficulty: ${config.difficulty}
Language: ${config.language}
Be realistic and conversational. Return JSON only: {"question": "..."}`;
}

export function buildInterviewTurnPrompt(input: {
  config: InterviewConfig;
  history: Array<{ question: string; answer?: string }>;
  answer: string;
}) {
  return `You are simulating a realistic interview.
Interview type: ${input.config.interviewType}
Role: ${input.config.role}
Difficulty: ${input.config.difficulty}
Language: ${input.config.language}
History: ${JSON.stringify(input.history)}
Latest candidate answer: ${input.answer}
Return JSON only with:
{
  "feedback": {
    "good": ["..."],
    "missing": ["..."],
    "strongAnswer": "..."
  },
  "nextQuestion": "..."
}
The interviewer should sound natural, e.g. 'Interesting, can you elaborate?' or 'Let's move on.'`;
}

export function buildInterviewDebriefPrompt(input: {
  config: InterviewConfig;
  turns: Array<{ question: string; answer?: string }>;
}) {
  return `You are an interview coach. Based on this interview transcript, return JSON only with:
{
  "overallScore": 0-100 integer,
  "communicationRating": 0-10 integer,
  "technicalAccuracyRating": 0-10 integer,
  "topImprovements": ["...", "...", "..."],
  "summary": "..."
}
Config: ${JSON.stringify(input.config)}
Transcript: ${JSON.stringify(input.turns)}`;
}
