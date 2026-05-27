/**
 * Thin markdown helpers shared across eval reporters. Each returns `string[]`
 * so callers can push lines directly into their own buffer:
 *
 *   const lines: string[] = [];
 *   lines.push(...renderHeader({ title: 'Foo', ... }));
 *   lines.push(...renderSummaryTable(['A', 'B'], rows));
 *   writeFileSync(path, lines.join('\n'));
 */

export interface ReportHeader {
  title: string;
  timestamp: string;
  model: string;
  judgeModel?: string;
  extra?: Record<string, string | number>;
}

export function renderHeader(h: ReportHeader): string[] {
  const lines = [`# ${h.title}`, ``, `- **Date**: ${h.timestamp}`, `- **Model**: ${h.model}`];
  if (h.judgeModel) lines.push(`- **Judge model**: ${h.judgeModel}`);
  for (const [k, v] of Object.entries(h.extra || {})) {
    lines.push(`- **${k}**: ${v}`);
  }
  lines.push(``);
  return lines;
}

export function renderSummaryTable(headers: string[], rows: string[][]): string[] {
  const sep = `|${headers.map(() => '---').join('|')}|`;
  const lines = [`| ${headers.join(' | ')} |`, sep];
  for (const r of rows) lines.push(`| ${r.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`);
  lines.push(``);
  return lines;
}
