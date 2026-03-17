export interface WebSearchSource {
  title: string;
  url: string;
  content: string;
  score: number;
}

export interface WebSearchResult {
  answer: string;
  sources: WebSearchSource[];
  query: string;
  responseTime: number;
}
