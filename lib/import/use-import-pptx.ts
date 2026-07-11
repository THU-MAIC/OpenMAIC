'use client';

import { useState, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createLogger } from '@/lib/logger';
import type { Slide } from '@openmaic/dsl';
// Type-only import: stripped at compile time, never reaches the bundler.
// pdfjs-dist (transitively pulled by `maic-importer/src`) uses dynamic
// `require()` patterns Turbopack refuses to bundle, so values flow through
// the URL-loaded dist instead. The workspace package only contributes types.
import type * as MaicImport from '@openmaic/importer';

const log = createLogger('ImportPptx');

export type PptxUpload = NonNullable<MaicImport.ImportPptxOptions['upload']>;

export interface UseImportPptxOptions {
  /**
   * Optional OSS uploader. When provided, every media blob (image, audio,
   * video) is uploaded and the resulting URL is written back into the slide.
   * When omitted, images stay as inline base64 and media falls back to a
   * temporary `blob:` URL (current tab only).
   */
  upload?: PptxUpload;
  /**
   * Called with the fully-converted canvas `Slide[]` after upload settles.
   * Until a caller wires this, the hook just logs the slides for inspection.
   */
  onImported?: (slides: Slide[]) => void;
}

/**
 * PPTX import flow: parse + convert + (optionally) upload media, all inside
 * the bundled `maic-importer` dist that we load by URL to bypass
 * Turbopack's hard rejection of pdfjs-dist's dynamic require.
 */
export function useImportPptx(options: UseImportPptxOptions = {}) {
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { t } = useI18n();
  const { upload, onImported } = options;

  const triggerFileSelect = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      e.target.value = '';

      setImporting(true);
      const toastId = toast.loading(t('import.parsingPptx'));

      try {
        // Static URL → bundler never sees the import target.
        // `scripts/sync-maic-importer.mjs` copies the prebuilt dist into
        // `public/vendor/` after every `pnpm install`.
        const url = '/vendor/maic-importer/index.js';

        // Runtime guard: the bundle is a gitignored artifact synced into
        // public/vendor during postinstall. If a deploy skipped that step the
        // URL 404s and `import()` fails with an opaque SyntaxError (404 HTML
        // parsed as JS). Probe first so we can report a clear, actionable error.
        let probe: Response | undefined;
        try {
          probe = await fetch(url, { method: 'HEAD' });
        } catch {
          // Network/HEAD unsupported — don't block; let import() report instead.
        }
        if (probe && !probe.ok) {
          throw new Error(`PARSER_NOT_DEPLOYED: ${url} → HTTP ${probe.status}`);
        }

        const mod = (await import(
          /* webpackIgnore: true */
          /* turbopackIgnore: true */
          /* @vite-ignore */
          url
        )) as typeof MaicImport;

        const slides = (await mod.importPptx(file, { upload })) as Slide[];

        log.info('pptx imported', { slideCount: slides.length });

        onImported?.(slides);

        toast.success(t('import.pptxSuccess', { count: slides.length }), { id: toastId });
      } catch (error) {
        log.error('PPTX import failed:', error);
        const notDeployed =
          error instanceof Error && error.message.startsWith('PARSER_NOT_DEPLOYED');
        toast.error(
          t(notDeployed ? 'import.error.parserUnavailable' : 'import.error.invalidPptx'),
          { id: toastId },
        );
      } finally {
        setImporting(false);
      }
    },
    [t, upload, onImported],
  );

  return {
    importing,
    fileInputRef,
    triggerFileSelect,
    handleFileChange,
  };
}
