import { describe, expect, it } from 'vitest';
import {
  getVideoExportCoverLabels,
  resolveVideoExportCta,
} from '@/lib/video-export-app/cover-config';
import type { Locale } from '@/lib/i18n';

const BIDI_CONTROL_CASES = [
  ['U+061C', '\u061c', '%D8%9C'],
  ['U+200E', '\u200e', '%E2%80%8E'],
  ['U+200F', '\u200f', '%E2%80%8F'],
  ['U+202A', '\u202a', '%E2%80%AA'],
  ['U+202B', '\u202b', '%E2%80%AB'],
  ['U+202C', '\u202c', '%E2%80%AC'],
  ['U+202D', '\u202d', '%E2%80%AD'],
  ['U+202E', '\u202e', '%E2%80%AE'],
  ['U+2066', '\u2066', '%E2%81%A6'],
  ['U+2067', '\u2067', '%E2%81%A7'],
  ['U+2068', '\u2068', '%E2%81%A8'],
  ['U+2069', '\u2069', '%E2%81%A9'],
] as const;

describe('resolveVideoExportCta', () => {
  it.each([undefined, '', '   '])('defaults an absent or blank value (%j)', (raw) => {
    expect(resolveVideoExportCta(raw)).toEqual({ destination: 'open.maic.chat' });
  });

  it.each(['off', 'OFF', ' Off '])('disables the CTA for %j', (raw) => {
    expect(resolveVideoExportCta(raw)).toBeNull();
  });

  it.each([
    ['https://Example.COM/learn/', 'example.com/learn'],
    ['http://open.maic.chat/', 'open.maic.chat'],
    ['courses.example.com/start/', 'courses.example.com/start'],
  ])('normalizes %j to the display destination %j', (raw, destination) => {
    expect(resolveVideoExportCta(raw)).toEqual({ destination });
  });

  it.each([
    'ftp://example.com',
    'javascript:alert(1)',
    'https://user:pass@example.com',
    'https://@example.com',
    'https://example.com/path?source=video',
    'https://example.com/path?',
    'https://example.com/path#section',
    'https://example.com/path#',
    'example.com/path?source=video',
    'example.com/path#section',
    'example.com/\u0000path',
  ])('rejects unsafe destination %j', (raw) => {
    expect(resolveVideoExportCta(raw)).toBeNull();
  });

  it('accepts 96 raw characters and rejects 97', () => {
    const at96 = `example.com/${'a'.repeat(84)}`;
    const at97 = `${at96}a`;

    expect(at96).toHaveLength(96);
    expect(at97).toHaveLength(97);
    expect(resolveVideoExportCta(at96)).toEqual({ destination: at96 });
    expect(resolveVideoExportCta(at97)).toBeNull();
  });

  it('keeps an accepted 96-character Unicode path human-readable and bounded', () => {
    const at96 = `a.co/${'学'.repeat(91)}`;

    expect(at96).toHaveLength(96);
    expect(resolveVideoExportCta(at96)).toEqual({ destination: at96 });
    expect(resolveVideoExportCta(at96)?.destination).toHaveLength(96);
  });

  it('preserves a Unicode IDN while lowercasing only ASCII host letters', () => {
    expect(resolveVideoExportCta('https://例え.Example/学ぶ/')).toEqual({
      destination: '例え.example/学ぶ',
    });
    expect(resolveVideoExportCta('https://İ.Example/Path')).toEqual({
      destination: 'İ.example/Path',
    });
  });

  it('decodes an unambiguous percent-encoded path for display', () => {
    expect(resolveVideoExportCta('https://Example.COM/%E5%AD%A6%E3%81%B6/')).toEqual({
      destination: 'example.com/学ぶ',
    });
  });

  it('normalizes ASCII host casing and trailing slashes without changing path casing', () => {
    expect(resolveVideoExportCta('HTTPS://Example.COM/LEARN///')).toEqual({
      destination: 'example.com/LEARN',
    });
  });

  it.each([
    ['https://Example.COM/a%2Fb', 'example.com/a%2Fb'],
    ['https://Example.COM/a%5Cb', 'example.com/a%5Cb'],
    ['https://Example.COM/a%3Fb', 'example.com/a%3Fb'],
    ['https://Example.COM/a%23b', 'example.com/a%23b'],
    ['https://Example.COM/a%25b', 'example.com/a%25b'],
  ])('preserves an encoded HTTP path delimiter in %j', (raw, destination) => {
    expect(resolveVideoExportCta(raw)).toEqual({ destination });
  });

  it.each(['https://example.com/%ZZ', 'https://example.com\\different-target'])(
    'rejects ambiguous or malformed display destination %j',
    (raw) => {
      expect(resolveVideoExportCta(raw)).toBeNull();
    },
  );

  it.each(BIDI_CONTROL_CASES)('rejects raw bidi control %s in the host', (_, raw) => {
    expect(resolveVideoExportCta(`https://safe${raw}.example/learn`)).toBeNull();
  });

  it.each(BIDI_CONTROL_CASES)('rejects raw bidi control %s in the path', (_, raw) => {
    expect(resolveVideoExportCta(`https://safe.example/a${raw}b`)).toBeNull();
  });

  it.each(BIDI_CONTROL_CASES)(
    'rejects percent-encoded bidi control %s in the host',
    (_, __, encoded) => {
      expect(resolveVideoExportCta(`https://safe${encoded}.example/learn`)).toBeNull();
    },
  );

  it.each(BIDI_CONTROL_CASES)(
    'rejects percent-encoded bidi control %s in the path',
    (_, __, encoded) => {
      expect(resolveVideoExportCta(`https://safe.example/a${encoded}b`)).toBeNull();
    },
  );

  it('preserves raw and percent-encoded ZWJ emoji sequences', () => {
    expect(resolveVideoExportCta('https://example.com/👩‍💻')).toEqual({
      destination: 'example.com/👩‍💻',
    });
    expect(resolveVideoExportCta('https://example.com/%F0%9F%91%A9%E2%80%8D%F0%9F%92%BB')).toEqual({
      destination: 'example.com/👩‍💻',
    });
  });
});

describe('getVideoExportCoverLabels', () => {
  const expectedCtaLabels: Record<
    Locale,
    Pick<
      ReturnType<typeof getVideoExportCoverLabels>,
      'quizCtaPrompt' | 'pblCtaPrompt' | 'ctaVisit'
    >
  > = {
    'en-US': {
      quizCtaPrompt: 'Want to try an interactive quiz?',
      pblCtaPrompt: 'Want to explore project-based learning?',
      ctaVisit: 'Visit',
    },
    'zh-CN': {
      quizCtaPrompt: '想亲自体验互动测验？',
      pblCtaPrompt: '想亲自参与项目学习？',
      ctaVisit: '访问',
    },
    'zh-TW': {
      quizCtaPrompt: '想親自體驗互動測驗？',
      pblCtaPrompt: '想親自參與專題式學習？',
      ctaVisit: '前往',
    },
    'ja-JP': {
      quizCtaPrompt: 'インタラクティブなクイズを体験しませんか？',
      pblCtaPrompt: 'プロジェクト型学習を体験しませんか？',
      ctaVisit: 'アクセス',
    },
    'ko-KR': {
      quizCtaPrompt: '인터랙티브 퀴즈를 직접 체험해 보세요',
      pblCtaPrompt: '프로젝트 기반 학습을 직접 체험해 보세요',
      ctaVisit: '방문',
    },
    'es-MX': {
      quizCtaPrompt: '¿Quieres probar un cuestionario interactivo?',
      pblCtaPrompt: '¿Quieres explorar el aprendizaje basado en proyectos?',
      ctaVisit: 'Visita',
    },
    'fr-FR': {
      quizCtaPrompt: 'Envie d’essayer un quiz interactif ?',
      pblCtaPrompt: 'Envie d’explorer l’apprentissage par projet ?',
      ctaVisit: 'Découvrir',
    },
    'pt-BR': {
      quizCtaPrompt: 'Quer experimentar um quiz interativo?',
      pblCtaPrompt: 'Quer explorar a aprendizagem baseada em projetos?',
      ctaVisit: 'Acesse',
    },
    'ru-RU': {
      quizCtaPrompt: 'Хотите пройти интерактивный тест?',
      pblCtaPrompt: 'Хотите попробовать проектное обучение?',
      ctaVisit: 'Посетите',
    },
    'ar-SA': {
      quizCtaPrompt: 'هل تريد تجربة اختبار تفاعلي؟',
      pblCtaPrompt: 'هل تريد استكشاف التعلم القائم على المشاريع؟',
      ctaVisit: 'تفضل بزيارة',
    },
  };

  it.each(Object.entries(expectedCtaLabels) as Array<[Locale, (typeof expectedCtaLabels)[Locale]]>)(
    'returns the approved CTA strings for %s',
    (locale, expected) => {
      expect(getVideoExportCoverLabels(locale)).toMatchObject(expected);
    },
  );
});
