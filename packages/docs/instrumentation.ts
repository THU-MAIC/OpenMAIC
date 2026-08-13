/**
 * The docs site is a standalone Next app (`output: 'export'`). Next 16 still
 * discovers the repo-root `instrumentation.ts` unless this package provides
 * its own, and that file imports app persistence modules that do not exist
 * here.
 */
export async function register(): Promise<void> {}
