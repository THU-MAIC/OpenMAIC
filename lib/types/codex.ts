import type { ModelInfo } from '@/lib/types/provider';

export interface CodexAccountInfo {
  type: 'chatgpt' | 'apiKey' | 'amazonBedrock';
  email?: string | null;
  planType?: string | null;
}

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface CodexRateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
}

export interface CodexProviderStatus {
  enabled: boolean;
  account: CodexAccountInfo | null;
  rateLimits: CodexRateLimitSnapshot | null;
  models: ModelInfo[];
}

export type CodexLoginStart =
  | { type: 'chatgpt'; loginId: string; authUrl: string }
  | {
      type: 'chatgptDeviceCode';
      loginId: string;
      verificationUrl: string;
      userCode: string;
    };
