import { afterEach, expect, it, vi } from 'vitest';
import ar from '@/lib/i18n/locales/ar-SA.json';
import { reportShareContent } from '@/lib/pbl/v3/report-share';
import { renderReportShareImage } from '@/lib/pbl/v3/report-share-image';
import type { LearningReport } from '@/lib/pbl/v3/report';

vi.mock('@/lib/export/qr-png', () => ({ qrPngDataUrl: async () => 'qr-image' }));
afterEach(() => vi.unstubAllGlobals());

function syntheticCanvas() {
  const drawn: { value: string; direction: string; align: string; x: number }[] = [];
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
    measureText: (value: string) => ({ width: value.length * 10 }),
    fillText(value: string, x: number) {
      drawn.push({ value, x, direction: this.direction, align: this.textAlign });
    },
  };
  vi.stubGlobal(
    'Image',
    class {
      src = '';
      async decode() {}
    },
  );
  vi.stubGlobal('document', {
    fonts: { load: async () => [] },
    createElement: () => ({
      getContext: () => context,
      toBlob: (callback: (blob: Blob) => void) => callback(new Blob(['png'])),
    }),
  });
  return drawn;
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

it.each(['landscape', 'portrait'] as const)(
  'keeps Arabic RTL and mixed numeric/URL/brand runs LTR in %s',
  async (orientation) => {
    const drawn = syntheticCanvas();
    await renderReportShareImage(content, orientation, 'dark', translate, 'ar-SA');
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
    expect(receipt?.value).toContain(ar.pblV3.share.decisionsLabel);
    expect(receipt?.value).toContain('\u206612\u2069');
    expect(drawn.map((item) => item.value).join(' ')).not.toMatch(
      /PRIVATE|private\.example|Decisions made|Quiz/,
    );
  },
);
