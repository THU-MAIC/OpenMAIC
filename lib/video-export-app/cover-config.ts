import type { Locale } from '@/lib/i18n';
import arSA from '@/lib/i18n/locales/ar-SA.json';
import enUS from '@/lib/i18n/locales/en-US.json';
import esMX from '@/lib/i18n/locales/es-MX.json';
import frFR from '@/lib/i18n/locales/fr-FR.json';
import jaJP from '@/lib/i18n/locales/ja-JP.json';
import koKR from '@/lib/i18n/locales/ko-KR.json';
import ptBR from '@/lib/i18n/locales/pt-BR.json';
import ruRU from '@/lib/i18n/locales/ru-RU.json';
import zhCN from '@/lib/i18n/locales/zh-CN.json';
import zhTW from '@/lib/i18n/locales/zh-TW.json';
import type { VideoExportLabels, VideoExportCta } from '@/lib/video-export';

const DEFAULT_DESTINATION = 'open.maic.chat';
const MAX_RAW_DESTINATION_LENGTH = 96;
const ASCII_CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const BIDI_CONTROL_CHARACTER = /[\u061c\u200e-\u200f\u202a-\u202e\u2066-\u2069]/;
const URL_SCHEME = /^[a-z][a-z\d+.-]*:/i;
const BARE_HOST_WITH_PORT = /^[a-z\d.-]+:\d+(?:\/|$)/i;

/**
 * Decode only URL-serialized non-ASCII code points. ASCII escapes stay exactly
 * encoded, so a valid HTTP path such as `a%2Fb` remains the same target while
 * authored CJK/emoji stays human-readable and bounded by the raw input length.
 */
function decodeUnicodePathForDisplay(serializedPath: string): string | null {
  if (/%(?![\da-f]{2})/i.test(serializedPath)) return null;
  let decodedControl = false;
  try {
    const display = serializedPath.replace(/(?:%[89a-f][\da-f])+/gi, (encoded) => {
      const decoded = decodeURIComponent(encoded);
      decodedControl ||= /\p{Cc}/u.test(decoded);
      return decoded;
    });
    return decodedControl ? null : display;
  } catch {
    return null;
  }
}

function normalizePercentHexCase(value: string): string {
  return value.replace(/%[\da-f]{2}/gi, (encoded) => encoded.toUpperCase());
}

const LOCALE_RESOURCES: Record<Locale, Record<string, unknown>> = {
  'en-US': enUS,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  'ja-JP': jaJP,
  'ko-KR': koKR,
  'es-MX': esMX,
  'fr-FR': frFR,
  'pt-BR': ptBR,
  'ru-RU': ruRU,
  'ar-SA': arSA,
};

/**
 * Resolve an environment-provided CTA destination without reading environment
 * state or producing side effects.
 */
export function resolveVideoExportCta(raw: string | undefined): VideoExportCta | null {
  const input = raw ?? '';
  const value = input.trim();
  if (!value) return { destination: DEFAULT_DESTINATION };
  if (value.toLowerCase() === 'off') return null;
  if (
    input.length > MAX_RAW_DESTINATION_LENGTH ||
    ASCII_CONTROL_CHARACTER.test(input) ||
    BIDI_CONTROL_CHARACTER.test(input)
  ) {
    return null;
  }

  const hasHttpScheme = /^https?:\/\//i.test(value);
  if (URL_SCHEME.test(value) && !hasHttpScheme && !BARE_HOST_WITH_PORT.test(value)) return null;
  if (value.includes('?') || value.includes('#') || value.includes('\\')) return null;

  const displayInput = hasHttpScheme ? value.replace(/^https?:\/\//i, '') : value;
  if (!displayInput || displayInput.startsWith('/')) return null;
  const firstSlash = displayInput.indexOf('/');
  const sourceAuthority = firstSlash === -1 ? displayInput : displayInput.slice(0, firstSlash);
  if (!sourceAuthority || sourceAuthority.includes('@')) return null;

  try {
    const url = new URL(hasHttpScheme ? value : `https://${value}`);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.hostname
    ) {
      return null;
    }

    // Keep the validated URL as the target identity, but derive the display
    // host from the source authority so an IDN stays readable instead of
    // expanding to punycode. The round-trip check below proves both map to the
    // same host and port.
    const sourceHostname = (() => {
      if (sourceAuthority.startsWith('[')) {
        const closingBracket = sourceAuthority.indexOf(']');
        if (closingBracket === -1) return null;
        const suffix = sourceAuthority.slice(closingBracket + 1);
        if (suffix && !/^:\d*$/.test(suffix)) return null;
        return sourceAuthority.slice(0, closingBracket + 1);
      }

      const lastColon = sourceAuthority.lastIndexOf(':');
      if (lastColon === -1) return sourceAuthority;
      const port = sourceAuthority.slice(lastColon + 1);
      if (!/^\d*$/.test(port)) return null;
      return sourceAuthority.slice(0, lastColon);
    })();
    if (!sourceHostname) return null;

    let displayHostname: string;
    try {
      displayHostname = decodeURIComponent(sourceHostname).replace(/[A-Z]/g, (char) =>
        char.toLowerCase(),
      );
    } catch {
      return null;
    }
    if (
      !displayHostname ||
      ASCII_CONTROL_CHARACTER.test(displayHostname) ||
      BIDI_CONTROL_CHARACTER.test(displayHostname) ||
      /[\\/?#@]/.test(displayHostname) ||
      (!sourceHostname.startsWith('[') && displayHostname.includes(':'))
    ) {
      return null;
    }

    const displayAuthority = `${displayHostname}${url.port ? `:${url.port}` : ''}`;
    const authorityCheck = new URL(`${url.protocol}//${displayAuthority}`);
    if (authorityCheck.hostname !== url.hostname || authorityCheck.port !== url.port) return null;

    // URL serialization percent-encodes authored Unicode. Decode only those
    // non-ASCII code points for display; valid encoded HTTP delimiters remain
    // encoded and therefore retain their exact target semantics.
    const serializedPath = url.pathname.replace(/\/+$/, '');
    const displayPath = decodeUnicodePathForDisplay(serializedPath);
    if (displayPath === null) return null;
    if (
      ASCII_CONTROL_CHARACTER.test(displayPath) ||
      BIDI_CONTROL_CHARACTER.test(displayPath) ||
      displayPath.includes('\\') ||
      displayPath.includes('?') ||
      displayPath.includes('#')
    ) {
      return null;
    }

    const pathCheck = new URL(`${url.protocol}//${url.host}${displayPath}`);
    if (
      normalizePercentHexCase(pathCheck.pathname.replace(/\/+$/, '')) !==
      normalizePercentHexCase(serializedPath)
    ) {
      return null;
    }

    const destination = `${displayAuthority}${displayPath}`;
    if (destination.length > value.length || destination.length > MAX_RAW_DESTINATION_LENGTH) {
      return null;
    }
    return { destination };
  } catch {
    return null;
  }
}

/** Resolve every learner-facing cover label synchronously for one export locale. */
export function getVideoExportCoverLabels(locale: Locale): VideoExportLabels {
  const resource = LOCALE_RESOURCES[locale];
  const at = (key: string): string => {
    const value = key.split('.').reduce<unknown>((current, part) => {
      if (!current || typeof current !== 'object') return undefined;
      return (current as Record<string, unknown>)[part];
    }, resource);
    if (typeof value !== 'string') {
      throw new Error(`Missing video-export cover label "${key}" for locale "${locale}"`);
    }
    return value;
  };
  return {
    quiz: at('quiz.title'),
    questions: at('quiz.questionsCount'),
    points: at('quiz.pointsSuffix'),
    singleChoice: at('quiz.singleChoice'),
    multipleChoice: at('quiz.multipleChoice'),
    shortAnswer: at('quiz.shortAnswer'),
    answerPlaceholder: at('quiz.inputPlaceholder'),
    pbl: at('pbl.v2.hero.title'),
    stages: at('pbl.v2.hero.stage'),
    tasks: at('pbl.v2.hero.task'),
    gains: at('pbl.v2.hero.youWillLearn'),
    instructor: at('pbl.v2.hero.tutor'),
    instructorTagline: at('pbl.v2.hero.instructorTagline'),
    scenarioCharacter: at('pbl.v2.hero.scenarioCharacter'),
    scenarioCharacterTagline: at('pbl.v2.hero.scenarioCharacterTagline'),
    quizCtaPrompt: at('export.videoQuizCtaPrompt'),
    pblCtaPrompt: at('export.videoPblCtaPrompt'),
    ctaVisit: at('export.videoCtaVisit'),
    interactive: {
      fallback: at('export.videoFailed'),
      readyTimeout: at('export.videoRendering'),
      loadFailure: at('export.videoFailed'),
      readyFailure: at('export.videoFailed'),
      runtimeFailure: at('export.videoFailed'),
    },
  };
}
