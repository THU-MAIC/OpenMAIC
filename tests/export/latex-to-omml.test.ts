import { describe, expect, it } from 'vitest';
import { latexToOmml } from '@/lib/export/latex-to-omml';

/**
 * mathml2omml writes DOCX-only `<w:rPr>` run properties for styled runs (an
 * upright Greek letter becomes `<m:r><w:rPr/><m:rPr><m:nor/>…`). A slide part
 * never declares the `w:` prefix, so one such run made the slide XML malformed
 * and PowerPoint refused the whole deck. The OMML must use only prefixes a
 * slide declares (`m:` and `a:`).
 */
describe('latexToOmml', () => {
  const styled = ['\\Delta U', '\\Omega', 'Z = R + jX\\ \\Omega', 'Δ U', '\\mathrm{d}x'];

  it('emits no w: elements for upright (styled) runs', () => {
    for (const latex of styled) {
      const omml = latexToOmml(latex, 17);
      expect(omml, latex).not.toBeNull();
      expect(omml, latex).not.toMatch(/<\/?w:/);
      expect(omml, latex).not.toMatch(/xmlns:w=/);
      const prefixes = new Set([...omml!.matchAll(/<(\w+):/g)].map((m) => m[1]));
      expect([...prefixes].sort(), latex).toEqual(['a', 'm']);
    }
  });

  it('gives styled runs the Cambria Math run properties after their m:rPr', () => {
    const omml = latexToOmml('\\Delta U_1', 17)!;
    expect(omml).toContain('<m:nor/>');
    const runs = omml.match(/<m:r>[\s\S]*?<\/m:r>/g) ?? [];
    expect(runs.length).toBeGreaterThan(1);
    for (const run of runs) expect(run).toContain('Cambria Math');
    // schema order inside m:r: m:rPr, a:rPr, m:t
    expect(omml).toMatch(/<m:rPr>[\s\S]*?<\/m:rPr>\s*<a:rPr[\s\S]*?<\/a:rPr>\s*<m:t/);
    expect(omml).not.toMatch(/<a:rPr[\s\S]*?<\/a:rPr>\s*<m:rPr>/);
  });
});
