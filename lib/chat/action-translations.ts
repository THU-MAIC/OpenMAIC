import { Badge } from '@/components/ui/badge';
import { CheckCircleIcon, CircleIcon, ClockIcon, XCircleIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { createElement } from 'react';

/**
 * Map SSE status strings to i18n keys under `actions.status.*`
 */
const statusKeyMap: Record<string, string> = {
  'input-streaming': 'inputStreaming',
  'input-available': 'inputAvailable',
  'output-available': 'outputAvailable',
  'output-error': 'outputError',
  'output-denied': 'outputDenied',
  running: 'running',
  result: 'result',
  error: 'error',
};

/**
 * Resolve an action name to its i18n display name.
 * Falls back to the raw actionName if no translation exists.
 */
export function getActionDisplayName(t: (key: string) => string, actionName: string): string {
  const translated = t(`actions.names.${actionName}`);
  // t() returns the key itself when translation is missing
  return translated === `actions.names.${actionName}` ? actionName : translated;
}

/**
 * Get a localized status badge for action state.
 */
export function getStatusBadge(t: (key: string) => string, state: string): ReactNode {
  const iconMap: Record<string, ReactNode> = {
    'input-streaming': createElement(CircleIcon, { className: 'size-4' }),
    'input-available': createElement(ClockIcon, {
      className: 'size-4 animate-pulse',
    }),
    'output-available': createElement(CheckCircleIcon, {
      className: 'size-4 text-green-600',
    }),
    'output-error': createElement(XCircleIcon, {
      className: 'size-4 text-red-600',
    }),
    'output-denied': createElement(XCircleIcon, {
      className: 'size-4 text-orange-600',
    }),
    running: createElement(ClockIcon, { className: 'size-4 animate-pulse' }),
    result: createElement(CheckCircleIcon, {
      className: 'size-4 text-green-600',
    }),
    error: createElement(XCircleIcon, { className: 'size-4 text-red-600' }),
  };

  const i18nKey = statusKeyMap[state];
  const label = i18nKey ? t(`actions.status.${i18nKey}`) : state;

  return createElement(
    Badge,
    {
      className: 'gap-1.5 rounded-full text-xs',
      variant: 'secondary' as const,
    },
    iconMap[state] || createElement(CircleIcon, { className: 'size-4' }),
    label,
  );
}

/**
 * Extract text parts from a message
 */
export function getMessageTextParts(message: {
  parts?: Array<{ type: string; text?: string; [key: string]: unknown }>;
}) {
  if (!message.parts || message.parts.length === 0) {
    return [];
  }
  return message.parts.filter((part) => part.type === 'text' || part.type === 'step-start');
}

/**
 * Extract action parts from a message
 */
export function getMessageActionParts(message: {
  parts?: Array<{ type: string; [key: string]: unknown }>;
}) {
  if (!message.parts || message.parts.length === 0) {
    return [];
  }
  return message.parts.filter((part) => part.type && part.type.startsWith('action-'));
}
