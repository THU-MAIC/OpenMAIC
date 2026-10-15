/**
 * How the agent is told about a material's parse state (#1880): in the
 * knowledge base page's own words, in the run's interface language, so what
 * it tells teachers matches what they see. A failure is the page's stable
 * reason code and wording, never the backend's diagnostic -- that carries
 * parser endpoints and configuration hints the model would repeat. The
 * diagnostic stays in the server log.
 *
 * The words live in tool results only, read for the locale in effect when the
 * tool runs; the system prompt and the tool descriptions carry the
 * language-neutral instruction below, so a later message in another language
 * cannot leave them saying something else.
 */
import type enUS from '@/lib/i18n/locales/en-US.json';
import type { Locale } from '@/lib/i18n/types';
import {
  extractionReasonCodeOf,
  type MaterialExtractionReasonCode,
} from '@/lib/types/material-extraction-failure';
import { MEDIA_MAX_DURATION_SEC } from '@/lib/types/media-limits';

type PageCopy = (typeof enUS)['workspace']['knowledgeBase'];

/** One loader per supported locale: only a whitelisted code ever names a file. */
const LOADERS: Record<Locale, () => Promise<{ default: typeof enUS }>> = {
  'zh-CN': () => import('@/lib/i18n/locales/zh-CN.json'),
  'zh-TW': () => import('@/lib/i18n/locales/zh-TW.json'),
  'en-US': () => import('@/lib/i18n/locales/en-US.json'),
  'ja-JP': () => import('@/lib/i18n/locales/ja-JP.json'),
  'ru-RU': () => import('@/lib/i18n/locales/ru-RU.json'),
  'ar-SA': () => import('@/lib/i18n/locales/ar-SA.json'),
  'pt-BR': () => import('@/lib/i18n/locales/pt-BR.json'),
  'ko-KR': () => import('@/lib/i18n/locales/ko-KR.json'),
  'es-MX': () => import('@/lib/i18n/locales/es-MX.json'),
  'fr-FR': () => import('@/lib/i18n/locales/fr-FR.json'),
  'vi-VN': () => import('@/lib/i18n/locales/vi-VN.json'),
  'de-DE': () => import('@/lib/i18n/locales/de-DE.json'),
};

/** Read-only copy per locale, loaded once; nothing here is a current language. */
const loaded = new Map<Locale, Promise<PageCopy>>();

function pageCopy(locale: Locale): Promise<PageCopy> {
  let copy = loaded.get(locale);
  if (!copy) {
    copy = LOADERS[locale]().then((module) => module.default.workspace.knowledgeBase);
    loaded.set(locale, copy);
  }
  return copy;
}

/** What a failed parse tells the model: the page's code, label and explanation. */
export interface MaterialFailureForModel {
  reasonCode?: MaterialExtractionReasonCode;
  /** The page's label for the failure; its generic failure without a known code. */
  reason: string;
  /** The page's explanation and next step (configure a parser, shorten a file...). */
  guidance?: string;
}

export interface MaterialModelCopy {
  /** A parse state as the page names it. */
  statusLabel(status: string): string;
  /** Why a parse failed; an unknown or legacy code reads as the generic failure. */
  failure(code: unknown, context?: 'library' | 'conversation'): MaterialFailureForModel;
  error(key: keyof PageCopy['error'], values?: Record<string, number>): string;
  /** The page's name for "not in a folder". */
  readonly topLevel: string;
}

export async function materialModelCopy(locale: Locale): Promise<MaterialModelCopy> {
  const page = await pageCopy(locale);
  return {
    statusLabel(status) {
      switch (status) {
        case 'pending':
        case 'running':
          return page.status.parsing;
        case 'done':
          return page.status.searchable;
        case 'failed':
          return page.status.failed;
        default:
          return page.status.stored;
      }
    },
    error(key, values) {
      return page.error[key].replace(/{{(\w+)}}/g, (_, name: string) =>
        String(values?.[name] ?? ''),
      );
    },
    failure(code, context = 'library') {
      const reasonCode = extractionReasonCodeOf(code);
      if (!reasonCode) return { reason: page.status.failed };
      const copy = page.failure[reasonCode];
      return {
        reasonCode,
        reason: copy.label,
        guidance: (context === 'conversation' && reasonCode === 'service_unavailable'
          ? page.conversationFailure.serviceUnavailable
          : copy.description
        ).replace('{{minutes}}', String(MEDIA_MAX_DURATION_SEC / 60)),
      };
    },
    topLevel: page.topLevel,
  };
}

/**
 * The language-neutral rule for talking about materials, in the tool
 * descriptions and the materials prompt block.
 */
export const MATERIAL_USER_WORDING =
  'Tool results give each material state as `statusLabel` (and, for a failure, `reason` and ' +
  "`guidance`), and a top-level folder as `folderLabel`, already in the user's interface " +
  'language: use those words with the user as they are. Never show the user tool names, field ' +
  'names, ids or raw values (such as `started: true`), and do not translate the internal ' +
  'status codes yourself.';
