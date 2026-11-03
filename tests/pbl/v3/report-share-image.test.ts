import { afterEach, expect, it, vi } from 'vitest';
import ar from '@/lib/i18n/locales/ar-SA.json';
import zh from '@/lib/i18n/locales/zh-CN.json';
import { reportShareCampaign, reportShareContent } from '@/lib/pbl/v3/report-share';
import { renderReportShareImage } from '@/lib/pbl/v3/report-share-image';
import type { LearningReport } from '@/lib/pbl/v3/report';

const qr = vi.hoisted(() => vi.fn(async (_url: string) => 'qr-image'));
vi.mock('@/lib/export/qr-png', () => ({ qrPngDataUrl: qr }));
afterEach(() => {
  vi.unstubAllGlobals();
  reportShareCampaign.url = '';
  qr.mockClear();
});

function syntheticCanvas() {
  const drawn: {
    value: string;
    direction: string;
    align: string;
    x: number;
    y: number;
    font: string;
    maxWidth?: number;
  }[] = [];
  const assets: string[] = [];
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
    fillText(value: string, x: number, y: number, maxWidth?: number) {
      drawn.push({
        value,
        x,
        y,
        direction: this.direction,
        align: this.textAlign,
        font: this.font,
        maxWidth,
      });
    },
  };
  vi.stubGlobal(
    'Image',
    class {
      src = '';
      naturalWidth = 1080;
      naturalHeight = 236;
      async decode() {
        assets.push(this.src);
      }
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
  return { drawn, canvas, context, assets };
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
    reportShareCampaign.url = 'https://workshop.example/intro';
    const { drawn, canvas, assets } = syntheticCanvas();
    await renderReportShareImage(content, theme, translate, 'ar-SA');
    expect([canvas.width, canvas.height]).toEqual([1200, 1500]);
    const prose = drawn.filter((item) => /[\u0600-\u06ff]/u.test(item.value));
    expect(prose.length).toBeGreaterThan(5);
    expect(prose.every((item) => item.direction === 'rtl' && item.align === 'right')).toBe(true);
    expect(assets).toContain('/openmaic-share-logo.png');
    expect(qr).toHaveBeenCalledWith(reportShareCampaign.url);
    expect(assets).toContain('qr-image');
    for (const value of [reportShareCampaign.url]) {
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

it.each([undefined, { skills: [], concepts: [] }])(
  'omits empty factual headings and metrics for summary=%j',
  async (summary) => {
    const { drawn } = syntheticCanvas();
    await renderReportShareImage(
      reportShareContent({
        project: { title: 'Project' },
        requiredComplete: false,
        summary,
      } as LearningReport),
      'light',
      translate,
      'ar-SA',
    );
    const values = drawn.map((item) => item.value);
    expect(values).not.toContain(ar.pblV3.share.skillsSection);
    expect(values).not.toContain(ar.pblV3.share.skillsMetric);
    expect(values).not.toContain(ar.pblV3.share.conceptsLabel);
    expect(values.join(' ')).not.toContain('0/0');
  },
);

it('can still save with a failed font and no roundRect support', async () => {
  const { drawn, context } = syntheticCanvas();
  Object.defineProperty(context, 'roundRect', { value: undefined });
  vi.spyOn(document.fonts, 'load').mockRejectedValue(new Error('Font resource unavailable'));
  const image = await renderReportShareImage(content, 'dark', translate, 'ar-SA');
  expect(image.size).toBeGreaterThan(0);
  expect(drawn.length).toBeGreaterThan(0);
  expect(drawn.every((item) => !item.font.includes('Inter Variable'))).toBe(true);
});

it('draws a mixed Chinese/Latin project title in full when it fits in two lines', async () => {
  const title = '用 Python 把自己的待办清单做出来学会添加事项按编号删除并验证实际操作的效果';
  const { drawn, context } = syntheticCanvas();
  context.measureText = (value: string) => ({
    width: Array.from(value).reduce(
      (width, character) => width + (/\p{Script=Han}/u.test(character) ? 40 : 20),
      0,
    ),
  });
  await renderReportShareImage({ ...content, title }, 'light', translate, 'zh-CN');
  const titleLines = drawn.filter((item) => item.font.startsWith('500 34px '));
  expect(titleLines).toHaveLength(2);
  expect(titleLines.map((item) => item.value).join('')).toBe(title);
  expect(titleLines.every((item) => context.measureText(item.value).width <= 1072)).toBe(true);
});

it.each(['light', 'dark'] as const)(
  'prints complete campaign URLs while preserving invisible-character escapes in %s',
  async (theme) => {
    for (const url of [
      'https://a.cn/工作坊前置课程',
      `https://course.example/${'intro'.repeat(35)}`,
      'https://a.cn/a%E2%80%8Bb',
      'https://a.cn/a%E2%80%AEb',
      'https://a.cn/a%CD%8Fb',
    ]) {
      reportShareCampaign.url = url;
      const { drawn, context } = syntheticCanvas();
      context.measureText = (value: string) => {
        const size = Number(/(\d+)px/.exec(context.font)?.[1] ?? 22);
        return {
          width: Array.from(value).reduce(
            (width, character) => width + (/\p{Script=Han}/u.test(character) ? size : size / 2),
            0,
          ),
        };
      };
      await renderReportShareImage(content, theme, translate, 'zh-CN');
      const printed = drawn.find((item) => item.value.startsWith('https://'))!;
      expect(printed.value).toBe(url);
      expect(printed).toMatchObject({ direction: 'ltr', align: 'left', maxWidth: 820 });
      expect(qr).toHaveBeenLastCalledWith(new URL(printed.value).href);
    }
  },
);

it.each(['', 'not a URL', 'javascript:alert(1)', 'https://user:password@course.example/'])(
  'omits promotion for %j without blocking image export',
  async (url) => {
    reportShareCampaign.url = url;
    const { drawn, assets } = syntheticCanvas();
    const image = await renderReportShareImage(content, 'light', translate, 'ar-SA');
    expect(image.size).toBeGreaterThan(0);
    expect(assets).toEqual(['/openmaic-share-logo.png']);
    expect(qr).not.toHaveBeenCalled();
    const text = drawn.map((item) => item.value).join(' ');
    expect(text).not.toContain(ar.pblV3.share.invite);
    expect(text).not.toMatch(/example\.com|replace before|上线前替换|OpenMAIC · Vibe Coding/);
  },
);

it('places the approved workshop, factual results and final invitation in order', async () => {
  reportShareCampaign.url = 'https://workshop.example/intro';
  const { drawn } = syntheticCanvas();
  const t = (key: string) => {
    let value: unknown = zh;
    for (const part of key.split('.')) value = (value as Record<string, unknown>)[part];
    return String(value);
  };
  await renderReportShareImage(content, 'light', t, 'zh-CN');
  const at = (value: string) => drawn.find((item) => item.value === value)!;
  expect(at(zh.pblV3.share.workshop).y).toBeLessThan(at(zh.pblV3.reportCopy.congratulations).y);
  expect(at(zh.pblV3.share.invite).y).toBeGreaterThan(at(zh.pblV3.share.testsPassed).y);
  expect(at(zh.pblV3.share.entryLabel).y).toBeGreaterThan(at(reportShareCampaign.url).y);
  expect(qr).toHaveBeenCalledWith(reportShareCampaign.url);
  expect(drawn.map((item) => item.value).join(' ')).not.toMatch(
    /OpenMAIC · Vibe Coding|示例|上线前替换/,
  );
});
