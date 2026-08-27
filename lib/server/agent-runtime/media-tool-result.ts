/**
 * Provider-neutral result shapes for the agent media-generation tools
 * (`generate_image`, `generate_video`).
 *
 * Tool results persist into the agent event stream consumed by the browser, so
 * both success details and failure text/details must use stable,
 * provider-neutral public error codes and generic text. Provider IDs, model
 * names, endpoints and raw exception messages stay exclusively in server-side
 * logs, correlated by the tool-call id.
 */

/** Stable public error codes shared by the image and video agent tools. */
export const MEDIA_TOOL_ERROR_REASONS = {
  noProvider: 'no-provider',
  providerDisabled: 'provider-disabled',
  unsupportedProvider: 'unsupported-provider',
  missingApiKey: 'missing-api-key',
  missingModel: 'missing-model',
  timeout: 'timeout',
  generationFailed: 'provider-or-storage-error',
} as const;

export type MediaToolErrorReason =
  (typeof MEDIA_TOOL_ERROR_REASONS)[keyof typeof MEDIA_TOOL_ERROR_REASONS];

export function errorResult(text: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: 'text' as const, text }],
    details,
    isError: true,
  };
}
