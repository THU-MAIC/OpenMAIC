/** Keep the first visible scene responsive when an upstream provider is unhealthy. */
export const FOREGROUND_SCENE_RETRY_OPTIONS = {
  maxRetries: 2,
} as const;
