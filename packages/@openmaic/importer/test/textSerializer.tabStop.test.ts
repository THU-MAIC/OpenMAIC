import { describe, it, expect, vi } from 'vitest';
import { renderTxBodyHtml } from './helpers';

/**
 * 回归（auto-fix.md 坑表）：标题/列表行用「前导 \t + 自定义 a:tabLst」推到图标右侧。
 *
 * 现象：标题整体右移、与图标间距过大、被甩到 96px 默认网格列（窄框还触发换行）；
 *       a2m 里裸 tab/tab-size 又不被 ProseMirror 保留 → 行塌回左边被图标盖住。
 * 修复：textSerializer 解析 a:tabLst 首个停靠位，把行首 \t 折进段落 margin-left
 *       （整块右移，单行与首行缩进视觉等价，a2m 也能忠实渲染），并把行首空白从 run 剥掉。
 */
describe('textSerializer · 行首 tab + tabLst 折叠成 margin-left', () => {
  const html = renderTxBodyHtml(`
    <a:p>
      <a:pPr marL="0" indent="0"><a:tabLst><a:tab pos="914400"/></a:tabLst></a:pPr>
      <a:r><a:rPr sz="1800"/><a:t>\t物资管理</a:t></a:r>
    </a:p>`);

  it('行首 \\t 折进 margin-left（tab pos=914400 EMU = 96px）', () => {
    expect(html).toContain('margin-left: 96px');
  });

  it('已折叠的行首 \\t 从正文剥掉：文本直接以「物」开头', () => {
    expect(html).toMatch(/>物资管理</);
    expect(html).not.toContain('\t物资管理');
  });
});

describe('textSerializer · inline custom tab columns', () => {
  const stops =
    '<a:tabLst><a:tab pos="1317625"/><a:tab pos="2639060"/><a:tab pos="3956685"/></a:tabLst>';

  it('uses the default grid after the last explicit stop instead of repeating the first stop', () => {
    const html = renderTxBodyHtml(
      `<a:p><a:pPr>${stops}</a:pPr><a:r><a:rPr sz="2800" spc="300"/><a:t>A.4\t\tB.0\t\t\tC.2\t\t\tD.6</a:t></a:r></a:p>`,
    );
    // B, C and D start at 277.066, 576 and 864 CSS px respectively.
    const widths = [...html.matchAll(/display:inline-block;width:([\d.]+)pt/g)].map(
      (m) => (Number(m[1]) * 4) / 3,
    );
    expect(widths.length).toBe(8);
    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(864, 1);
    expect(html).not.toContain('\t');
    expect(html).toContain('D.6');
  });

  it('keeps irregular explicit stops, inherited default tab size and run styling', () => {
    const html = renderTxBodyHtml(
      `<a:lstStyle><a:lvl1pPr defTabSz="457200"/></a:lstStyle><a:p><a:pPr><a:tabLst><a:tab pos="952500"/><a:tab pos="2381250"/></a:tabLst></a:pPr><a:r><a:rPr sz="1000"/><a:t>A\tB\t</a:t></a:r><a:r><a:rPr sz="1000"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:rPr><a:t>C\tD</a:t></a:r></a:p>`,
    );
    expect(html).toContain('width:75.00pt');
    expect(html).toContain('width:112.50pt');
    expect(html).toContain('width:28.50pt');
    expect(html).toContain('color: #FF0000');
  });
});

describe('textSerializer · tab measurement matches painted styles', () => {
  it('measures table font overrides and uppercase before choosing a stop', () => {
    const measured: { text: string; font: string }[] = [];
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext() {
          return {
            font: '',
            measureText(text: string) {
              measured.push({ text, font: this.font });
              return {
                width:
                  text === 'AB' && this.font.includes('bold') && this.font.includes('Courier')
                    ? 110
                    : 40,
              };
            },
          };
        }
      },
    );
    try {
      const html = renderTxBodyHtml(
        `<a:lstStyle><a:lvl1pPr><a:defRPr><a:latin typeface="Arial"/></a:defRPr></a:lvl1pPr></a:lstStyle><a:p><a:pPr><a:tabLst><a:tab pos="952500"/><a:tab pos="1905000"/></a:tabLst></a:pPr><a:r><a:rPr sz="1000" cap="all"/><a:t>ab\tC</a:t></a:r></a:p>`,
        undefined,
        { cellTextFontFamily: 'Courier', cellTextBold: true },
      );
      expect(measured[0].text).toBe('AB');
      expect(measured[0].font).toContain('bold');
      expect(measured[0].font).toContain('Courier');
      expect(html).toContain('width:150.00pt');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

it('keeps native tab layout for inline math whose rendered width is not a text metric', () => {
  const html = renderTxBodyHtml(
    `<a:p><a:pPr><a:tabLst><a:tab pos="952500"/></a:tabLst></a:pPr><m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:r><m:t>x</m:t></m:r></m:oMath><a:r><a:rPr sz="1200"/><a:t>\tB</a:t></a:r></a:p>`,
  );
  expect(html).toContain('tab-size:');
  expect(html).not.toContain('display:inline-block;width:');
});

it('starts tab measurement after the hanging bullet slot', () => {
  const html = renderTxBodyHtml(
    '<a:p><a:pPr marL="381000" indent="-190500"><a:buChar char="•"/><a:tabLst><a:tab pos="952500"/></a:tabLst></a:pPr><a:r><a:rPr sz="1200"/><a:t>A\tB</a:t></a:r></a:p>',
  );
  // Text starts at 40px after the 20px bullet slot. The remaining column is 60px.
  expect(html).toContain('width:45.00pt;');
});

it.each(['ctr', 'r'])('keeps text at the start of a tab column in %s paragraphs', (align) => {
  const html = renderTxBodyHtml(
    `<a:p><a:pPr algn="${align}"><a:tabLst><a:tab pos="952500"/></a:tabLst></a:pPr><a:r><a:rPr sz="1200"/><a:t>A\tB</a:t></a:r></a:p>`,
  );
  expect(html).toMatch(/display:inline-block;[^\"]*text-align:left;/);
});

it('measures baseline-shifted text at its final painted size', () => {
  const measuredFonts: string[] = [];
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      getContext() {
        return {
          font: '',
          measureText(text: string) {
            measuredFonts.push(this.font);
            return { width: text === 'AAAA' ? (this.font.includes('17.333') ? 46.25 : 71.13) : 10 };
          },
        };
      }
    },
  );
  try {
    const html = renderTxBodyHtml(
      '<a:p><a:pPr><a:tabLst><a:tab pos="571500"/><a:tab pos="952500"/></a:tabLst></a:pPr><a:r><a:rPr sz="2000" baseline="30000"><a:latin typeface="Arial"/></a:rPr><a:t>AAAA\tB</a:t></a:r></a:p>',
    );
    expect(measuredFonts[0]).toContain('17.333');
    expect(html).toContain('width:45.00pt;');
  } finally {
    vi.unstubAllGlobals();
  }
});

it('marks custom tab columns so the editor can preserve their boundaries', () => {
  const html = renderTxBodyHtml(
    '<a:p><a:pPr><a:tabLst><a:tab pos="952500"/><a:tab pos="1905000"/></a:tabLst></a:pPr><a:r><a:rPr sz="1200"/><a:t>A\tB\tC</a:t></a:r></a:p>',
  );
  expect(html.match(/data-pptx-tab-column="true"/g)).toHaveLength(2);
});

it('serializes default-grid tabs as editable columns even without a custom tab list', () => {
  const html = renderTxBodyHtml(`<a:p><a:r><a:rPr sz="1200"/><a:t>A\t\t\tB</a:t></a:r></a:p>`);
  expect(html.match(/data-pptx-tab-column="true"/g)).toHaveLength(3);
  expect(html).not.toContain('\t');
  expect(html).not.toContain('tab-size:');
});

it('uses inherited default tab spacing without requiring custom stops', () => {
  const html = renderTxBodyHtml(`<a:lstStyle><a:lvl1pPr defTabSz="457200"/></a:lstStyle>
    <a:p><a:r><a:rPr sz="1200"/><a:t>A\tB</a:t></a:r></a:p>`);
  expect(html).toContain('data-pptx-tab-column="true"');
  expect(html).toContain('width:36.00pt;');
});
