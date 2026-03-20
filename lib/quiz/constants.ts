import type { CodingLanguage, CodingTopic, PlacementTopic } from './types';

export const QUIZ_HISTORY_STORAGE_KEY = 'openmaic.quiz.history';

export const PLACEMENT_TOPICS: Array<{ value: PlacementTopic; label: string }> = [
  { value: 'quant', label: 'Quantitative Aptitude' },
  { value: 'logical', label: 'Logical Reasoning' },
  { value: 'verbal', label: 'Verbal Ability' },
  { value: 'data-interpretation', label: 'Data Interpretation' },
];

export const CODING_TOPICS: Array<{ value: CodingTopic; label: string }> = [
  { value: 'arrays', label: 'Arrays' },
  { value: 'strings', label: 'Strings' },
  { value: 'trees', label: 'Trees' },
  { value: 'graphs', label: 'Graphs' },
  { value: 'dynamic-programming', label: 'Dynamic Programming' },
  { value: 'sorting', label: 'Sorting' },
  { value: 'complexity', label: 'Time / Space Complexity' },
  { value: 'output-prediction', label: 'Output Prediction' },
  { value: 'debugging', label: 'Code Debugging' },
  { value: 'fill-in-the-blank', label: 'Fill in the Blank' },
];

export const CODING_LANGUAGES: Array<{ value: CodingLanguage; label: string }> = [
  { value: 'python', label: 'Python' },
  { value: 'java', label: 'Java' },
  { value: 'cpp', label: 'C++' },
  { value: 'javascript', label: 'JavaScript' },
];
