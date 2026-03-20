import type { CodingDifficulty, CodingLanguage, PlacementDifficulty } from './types';

export function buildPlacementQuizPrompt(params: {
  company: string;
  difficulty: PlacementDifficulty;
  language: string;
}) {
  return `Generate a fresh placement aptitude quiz in JSON only.
Track: Placement Aptitude
Company style: ${params.company}
Difficulty: ${params.difficulty}
Response language for instructions/explanations: ${params.language}
Return exactly 20 multiple-choice questions covering quant, logical reasoning, verbal ability, and data interpretation.
JSON format:
{
  "track": "placement-aptitude",
  "title": "...",
  "company": "${params.company}",
  "difficulty": "${params.difficulty}",
  "durationMinutes": 30,
  "questions": [
    {
      "id": "q1",
      "type": "mcq",
      "topic": "quant|logical|verbal|data-interpretation",
      "difficulty": "easy|medium|hard",
      "question": "...",
      "options": [{"id": "A", "text": "..."}, {"id": "B", "text": "..."}, {"id": "C", "text": "..."}, {"id": "D", "text": "..."}],
      "correctAnswer": "A",
      "explanation": "..."
    }
  ]
}
No markdown.`;
}

export function buildCodingQuizPrompt(params: {
  language: CodingLanguage;
  difficulty: CodingDifficulty;
}) {
  return `Generate a fresh coding examination in JSON only.
Language: ${params.language}
Difficulty: ${params.difficulty}
Return exactly 3 coding problems inspired by LeetCode-style interviews. Mix DSA / complexity / debugging / output prediction / fill-in-the-blank where sensible.
JSON format:
{
  "track": "coding-examination",
  "title": "...",
  "language": "${params.language}",
  "difficulty": "${params.difficulty}",
  "durationMinutes": 60,
  "problems": [
    {
      "id": "p1",
      "type": "coding",
      "title": "...",
      "topic": "arrays|strings|trees|graphs|dynamic-programming|sorting|complexity|output-prediction|debugging|fill-in-the-blank",
      "difficulty": "easy|medium|hard",
      "prompt": "...",
      "inputFormat": "...",
      "outputFormat": "...",
      "constraints": ["..."],
      "examples": [{"input": "...", "output": "...", "explanation": "..."}],
      "hints": ["..."],
      "starterCode": "..."
    }
  ]
}
No markdown.`;
}

export function buildPlacementDebriefPrompt(summary: string) {
  return `You are a placement coach. Based on the quiz summary below, return JSON only with keys summary, revisionTopics, percentileEstimate.
Summary:
${summary}`;
}

export function buildCodeReviewPrompt(input: {
  title: string;
  prompt: string;
  code: string;
  language: CodingLanguage;
}) {
  return `You are reviewing a coding interview submission. Return JSON only with keys summary, strengths, missingPoints, optimalApproach, timeComplexity, spaceComplexity, cleanerVersion.
Problem title: ${input.title}
Language: ${input.language}
Problem:
${input.prompt}
Candidate code:
${input.code}`;
}
