import { mkdirSync } from 'fs';
import { join } from 'path';

/**
 * Build and create a run directory under `<baseDir>/<sanitized-model>/<timestamp>/`.
 * The model string is sanitized by replacing `:` and `/` with `-` so it is
 * safe to use as a directory name. Timestamp is ISO-8601 with colons and dots
 * replaced by dashes, truncated to second precision.
 */
export function createRunDir(baseDir: string, model: string): string {
  const sanitizedModel = model.replace(/[:/]/g, '-');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runDir = join(baseDir, sanitizedModel, timestamp);
  mkdirSync(runDir, { recursive: true });
  return runDir;
}
