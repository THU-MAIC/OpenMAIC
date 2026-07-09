import type { ValidationReport, ValidationLayer } from './types';
import { validateStaticHtml } from './validators/static-html';
import { lintEmbeddedJs } from './validators/lint-js';
import { validateHeadless } from './validators/headless';

function combine(layers: ValidationLayer[]): ValidationReport['overall'] {
  if (layers.some((l) => l.status === 'fail')) return 'fail';
  if (layers.some((l) => l.status === 'warn')) return 'warn';
  return 'pass';
}

export async function runValidation(html: string): Promise<ValidationReport> {
  const stat = await validateStaticHtml(html);
  const lint = await lintEmbeddedJs(html);
  const head = await validateHeadless(html);
  const layers = [stat, lint, head];
  return { overall: combine(layers), layers };
}
