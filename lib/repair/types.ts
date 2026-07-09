/**
 * Shared types for the interactive-slide validation harness.
 *
 * A generated interactive slide is validated across independent layers; each
 * returns a {@link ValidationLayer} and they are combined into a single
 * {@link ValidationReport}. See `lib/repair/validate.ts`.
 */

export interface ValidationLayer {
  name: 'static-html' | 'lint-js' | 'headless';
  status: 'pass' | 'warn' | 'fail';
  messages: string[];
}

export interface ValidationReport {
  overall: 'pass' | 'warn' | 'fail';
  layers: ValidationLayer[];
}
