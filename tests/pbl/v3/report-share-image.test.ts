import { afterEach, expect, it, vi } from 'vitest';
import ar from '@/lib/i18n/locales/ar-SA.json';
import zh from '@/lib/i18n/locales/zh-CN.json';
import { reportShareContent } from '@/lib/pbl/v3/report-share';
import { renderReportShareImage } from '@/lib/pbl/v3/report-share-image';
import type { LearningReport } from '@/lib/pbl/v3/report';

vi.mock('@/lib/export/qr-png', () => ({ qrPngDataUrl: async () => 'qr-image' }));
afterEach(() => vi.unstubAllGlobals());

function syntheticCanvas() {
  const drawn: { value: string; direction: string; align: string; x: number; font: string }[] = [];
  const context = {
    direction: 'inherit',
    textAlign: 'start',
    font: '',
    fillStyle: '',
    createLinearGradient: () => ({ addColorStop() {} }),
    fillRect() {},
    beginPath() {},
    roundRect() {},
    fill() {},
    drawImage() {},
    save() {},
    translate() {},
    rotate() {},
    restore() {},
    moveTo() {},
    lineTo() {},
    quadraticCurveTo() {},
    closePath() {},
    stroke() {},
    arc() {},
    measureText: (value: string) => ({ width: value.length * 10 }),
    fillText(value: string, x: number) {
      drawn.push({ value, x, direction: this.direction, align: this.textAlign, font: this.font });
    },
  };
  vi.stubGlobal(
    'Image',
    class {
      src = '';
      async decode() {}
    },
  );
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => context,
    toBlob: (callback: (blob: Blob) => void) => callback(new Blob(['png'])),
  };
  vi.stubGlobal('document', {
    fonts: { load: async () => [] },
    createElement: () => canvas,
  });
  return { drawn, canvas, context };
}

const content = reportShareContent({
  project: { title: 'مشروع تجريبي' },
  requiredComplete: true,
  summary: {
    completedMilestones: 1,
    totalMilestones: 1,
    completedSteps: 7,
    totalSteps: 7,
    skills: [{ id: 'planReview', milestoneIds: ['one'] }],
    concepts: ['القوائم'],
  },
  facts: { decisions: 12 },
  outcomes: [{ tests: 'passed', quiz: { score: 2, total: 10 } }],
  analysis: { status: 'ready', findings: [{ title: 'PRIVATE https://private.example' }] },
} as unknown as LearningReport);

function translate(key: string) {
  let value: unknown = ar;
  for (const part of key.split('.')) value = (value as Record<string, unknown>)[part];
  return String(value);
}

it.each(['light', 'dark'] as const)(
  'keeps one 4:5 image with Arabic RTL and numeric/URL/brand LTR in %s',
  async (theme) => {
    const { drawn, canvas } = syntheticCanvas();
    await renderReportShareImage(content, theme, translate, 'ar-SA');
    expect([canvas.width, canvas.height]).toEqual([1200, 1500]);
    const prose = drawn.filter((item) => /[\u0600-\u06ff]/u.test(item.value));
    expect(prose.length).toBeGreaterThan(5);
    expect(prose.every((item) => item.direction === 'rtl' && item.align === 'right')).toBe(true);
    for (const value of ['OpenMAIC', 'https://example.com/vibe-intro', 'OpenMAIC · Vibe Coding']) {
      expect(drawn.find((item) => item.value === value)).toMatchObject({
        direction: 'ltr',
        align: 'left',
      });
    }
    expect(drawn.find((item) => item.value === '1/1')).toMatchObject({
      direction: 'ltr',
      align: 'right',
    });
    const receipt = drawn.find((item) => item.value.includes('\u20662/10\u2069'));
    expect(receipt?.value).toContain(ar.pblV3.share.quizLabel);
    const decisions = drawn.find((item) => item.value.includes(ar.pblV3.share.decisionsLabel));
    expect(decisions?.value).toContain('\u206612\u2069');
    expect(drawn.map((item) => item.value).join(' ')).not.toMatch(
      /PRIVATE|private\.example|Decisions made|Quiz|✓/,
    );
  },
);

it.each([true, false])(
  'uses the congratulatory heading only when completed=%s',
  async (completed) => {
    const { drawn } = syntheticCanvas();
    const t = (key: string) => {
      let value: unknown = zh;
      for (const part of key.split('.')) value = (value as Record<string, unknown>)[part];
      return String(value);
    };
    await renderReportShareImage({ ...content, completed }, 'light', t, 'zh-CN');
    const text = drawn.map((item) => item.value).join(' ');
    expect(text).toContain(
      completed ? zh.pblV3.reportCopy.congratulations : zh.pblV3.share.achievement,
    );
    expect(text).not.toContain(
      completed ? zh.pblV3.share.achievement : zh.pblV3.reportCopy.congratulations,
    );
    expect(text).toContain(zh.pblV3.share.skillsSection);
    expect(text).not.toContain(zh.pblV3.reportCopy.skills);
  },
);

it('omits empty factual sections instead of drawing empty headings or inventing counts', async () => {
  const { drawn } = syntheticCanvas();
  await renderReportShareImage(
    reportShareContent({
      project: { title: 'Project' },
      requiredComplete: false,
    } as LearningReport),
    'light',
    translate,
    'ar-SA',
  );
  const values = drawn.map((item) => item.value);
  expect(values).not.toContain(ar.pblV3.share.skillsSection);
  expect(values).not.toContain(ar.pblV3.share.conceptsLabel);
  expect(values.join(' ')).not.toContain('0/0');
});

it('can still save with a failed font and no roundRect support', async () => {
  const { drawn, context } = syntheticCanvas();
  Object.defineProperty(context, 'roundRect', { value: undefined });
  vi.spyOn(document.fonts, 'load').mockRejectedValue(new Error('Font resource unavailable'));
  const image = await renderReportShareImage(content, 'dark', translate, 'ar-SA');
  expect(image.size).toBeGreaterThan(0);
  expect(drawn.length).toBeGreaterThan(0);
  expect(drawn.every((item) => !item.font.includes('Inter Variable'))).toBe(true);
});
