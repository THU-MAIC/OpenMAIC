import { HtmlValidate, Severity } from 'html-validate';
import type { ValidationLayer } from '../types';

// Structural-only config: detect malformed markup (unclosed/mismatched tags, duplicate ids,
// void-element misuse) without flagging valid-but-minimal HTML for missing lang/head/title.
// The 'recommended' preset is too strict for slide widget HTML that omits doc-level boilerplate.
const validator = new HtmlValidate({
  root: true,
  rules: {
    'close-order': 'error',
    'no-dup-id': 'error',
    'void-content': 'error',
    'no-raw-characters': 'off',
    'element-required-content': 'off',
    'element-required-attributes': 'off',
    'missing-doctype': 'off',
    'void-style': 'off',
  },
});

export async function validateStaticHtml(html: string): Promise<ValidationLayer> {
  const report = await validator.validateString(html);
  const messages = report.results.flatMap((r) =>
    r.messages.map((m) => `${m.ruleId} (${m.line}:${m.column}): ${m.message}`),
  );
  const hasError = report.results.some((r) =>
    r.messages.some((m) => m.severity === Severity.ERROR),
  );
  return {
    name: 'static-html',
    status: hasError ? 'fail' : messages.length ? 'warn' : 'pass',
    messages,
  };
}
