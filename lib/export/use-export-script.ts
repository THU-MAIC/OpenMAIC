'use client';

/**
 * `useExportScript` — download the classroom narration script (the
 * `SpeechAction.text` per scene) as Markdown or a genuine OOXML `.docx` file.
 *
 * Issue #413: teachers want the TTS narration text as a local document for
 * lesson prep/reference, not just the PPTX export. This is a pure client-side
 * collection + serialization + download — no server route or media work.
 *
 * App-side / impure: store read, sonner toast, `saveAs` download.
 */
import { useCallback, useRef, useState } from 'react';
import { saveAs } from 'file-saver';
import { toast } from 'sonner';

import { useStageStore } from '@/lib/store';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createLogger } from '@/lib/logger';
import type { Scene } from '@/lib/types/stage';

const log = createLogger('ExportScript');

/** One scene's narration, collected from its speech actions. */
export interface SceneScript {
  sceneId: string;
  sceneTitle: string;
  sceneOrder: number;
  text: string;
}

export type ScriptFormat = 'md' | 'docx';

export const SCRIPT_MIME_TYPES: Record<ScriptFormat, string> = {
  md: 'text/markdown;charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/**
 * Collect each scene's narration: concatenate its `SpeechAction.text` values in
 * action order. Scenes with no speech text are omitted entirely. `slideFallback`
 * supplies the locale-appropriate label for scenes with an empty title.
 */
export function collectSceneScripts(
  scenes: Scene[],
  slideFallback: (order: number) => string,
): SceneScript[] {
  const scripts: SceneScript[] = [];
  for (const scene of scenes) {
    const parts: string[] = [];
    for (const action of scene.actions ?? []) {
      if (action.type === 'speech' && action.text.trim()) {
        parts.push(action.text.trim());
      }
    }
    const text = parts.join('\n');
    if (!text) continue;
    scripts.push({
      sceneId: scene.id,
      sceneTitle: scene.title || slideFallback(scene.order),
      sceneOrder: scene.order,
      text,
    });
  }
  return scripts;
}

/** Normalize CRLF and lone CR line endings for consistent cross-format output. */
function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

/**
 * Neutralize a scene/stage title before it's interpolated into a Markdown
 * heading: flatten embedded newlines to spaces, then backslash-escape a
 * leading `#` run so it renders as literal text instead of Markdown heading
 * syntax. Escaping (not stripping) preserves titles that legitimately start
 * with `#` (e.g. "#1 Introduction") while still neutralizing the character's
 * special meaning. Newlines are flattened before the leading-`#` check so a
 * title like "\n# Injected" can't dodge the escape by shielding its `#`
 * behind whitespace that a later `trim()` would otherwise re-expose.
 */
function sanitizeMarkdownHeading(text: string): string {
  const flattened = text.replace(/[\r\n]+/g, ' ').trim();
  return flattened.replace(/^#+/, (hashes) =>
    hashes
      .split('')
      .map((h) => `\\${h}`)
      .join(''),
  );
}

/** Serialize collected scripts as a Markdown document. */
export function buildMarkdown(stageName: string, scripts: SceneScript[]): string {
  const lines = [`# ${sanitizeMarkdownHeading(stageName)}`];
  for (const script of scripts) {
    if (!script.text) continue;
    lines.push('', `## ${sanitizeMarkdownHeading(script.sceneTitle)}`, '');
    const paragraphs = normalizeLineEndings(script.text)
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.replace(/\n/g, ' ').trim())
      .filter(Boolean);
    for (const paragraph of paragraphs) {
      lines.push(paragraph, '');
    }
  }
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

type DocxApi = Pick<typeof import('docx'), 'Document' | 'HeadingLevel' | 'Paragraph' | 'TextRun'>;

/**
 * Build the document model used by the browser-only DOCX serializer.
 * `docx` is passed in rather than imported at module evaluation time so the
 * normal classroom header does not eagerly load the OOXML library.
 */
export function buildDocxDocument(
  stageName: string,
  scripts: SceneScript[],
  api: DocxApi,
): InstanceType<DocxApi['Document']> {
  const children = [new api.Paragraph({ text: stageName, heading: api.HeadingLevel.HEADING_1 })];

  for (const script of scripts) {
    if (!script.text) continue;
    children.push(
      new api.Paragraph({ text: script.sceneTitle, heading: api.HeadingLevel.HEADING_2 }),
    );
    for (const raw of normalizeLineEndings(script.text).split(/\n{2,}/)) {
      const paragraph = raw.trim();
      if (!paragraph) continue;
      const lines = paragraph.split('\n');
      children.push(
        new api.Paragraph({
          children: lines.map(
            (line, index) => new api.TextRun({ text: line, break: index > 0 ? 1 : undefined }),
          ),
        }),
      );
    }
  }

  return new api.Document({ sections: [{ children }] });
}

/** Build a genuine OOXML DOCX blob using the browser-compatible `docx` package. */
export async function buildDocxBlob(stageName: string, scripts: SceneScript[]): Promise<Blob> {
  const api = await import('docx');
  const document = buildDocxDocument(stageName, scripts, api);
  return api.Packer.toBlob(document);
}

/**
 * Build a safe download file name: `<stem>-script.<ext>`. Illegal filename
 * characters are stripped, whitespace runs collapse to a single `-`, and an
 * empty stem falls back to `script`.
 */
export function buildScriptFileName(stageName: string, ext: ScriptFormat): string {
  const cleaned = stageName
    .replace(/[\u0000-\u001f\u007f\u200b-\u200c\u200e-\u200f\ufeff\\/:*?"<>|]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned ? `${cleaned}-script.${ext}` : `script.${ext}`;
}

/** Shared export hook — exposes Markdown and DOCX downloads. */
export function useExportScript() {
  const { t } = useI18n();
  const [exporting, setExporting] = useState(false);
  const exportingRef = useRef(false);

  const downloadScript = useCallback(
    async (format: ScriptFormat) => {
      if (exportingRef.current) return;

      const scenes = useStageStore.getState().scenes;
      const stage = useStageStore.getState().stage;
      const scripts = collectSceneScripts(scenes, (order) => t('export.slideFallback', { order }));
      if (scripts.length === 0) {
        toast.warning(t('export.nothingToExport'));
        return;
      }

      const isAsync = format === 'docx';
      if (isAsync) {
        exportingRef.current = true;
        setExporting(true);
      }

      try {
        const fileName = stage?.name || 'classroom';
        let blob: Blob;
        if (format === 'md') {
          blob = new Blob([buildMarkdown(fileName, scripts)], {
            type: SCRIPT_MIME_TYPES.md,
          });
        } else {
          blob = await buildDocxBlob(fileName, scripts);
          // Some Blob implementations inherit a generic type from the packer;
          // normalize it before handing the file to the browser download API.
          if (blob.type !== SCRIPT_MIME_TYPES.docx) {
            blob = new Blob([blob], { type: SCRIPT_MIME_TYPES.docx });
          }
        }
        saveAs(blob, buildScriptFileName(fileName, format));
        toast.success(t('export.exportSuccess'));
      } catch (error) {
        log.error(`Script export failed (${format}):`, error);
        toast.error(t('export.exportFailed'));
      } finally {
        if (isAsync) {
          exportingRef.current = false;
          setExporting(false);
        }
      }
    },
    [t],
  );

  return {
    exporting,
    exportScriptDocx: () => void downloadScript('docx'),
    exportScriptMd: () => void downloadScript('md'),
  };
}
