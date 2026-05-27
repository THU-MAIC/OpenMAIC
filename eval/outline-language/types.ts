export interface LanguageTestCase {
  case_id: string;
  category: string;
  requirement: string;
  ground_truth: string;
  pdfTextSample?: string;
}

export interface JudgeResult {
  pass: boolean;
  reason: string;
}

export interface EvalResult {
  case_id: string;
  category: string;
  requirement: string;
  pdfTextSample?: string;
  groundTruth: string;
  directive: string;
  outlinesCount: number;
  judgePassed: boolean;
  judgeReason: string;
}
