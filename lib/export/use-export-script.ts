'use client';

/**
 * `useExportScript` — download the classroom narration script (the
 * `SpeechAction.text` per scene) as a Markdown or Word-compatible `.doc` file.
 *
 * Issue #413: teachers want the TTS narration text as a local document for
 * lesson prep/reference, not just the PPTX export. This is a pure client-side
 * collection + serialization + download — no slides, no media, no new runtime
 * dependencies (the `.doc` is a minimal HTML document with the Word MIME type).
 *
 * App-side / impure: store read, sonner toast, `saveAs` download.
 */
import { useCallback } from 'react';
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

/**
 * Collect each scene's narration: concatenate its `SpeechAction.text` values in
 * action order. Scenes with no speech text are omitted entirely.
 */
export function collectSceneScripts(scenes: Scene[]): SceneScript[] {
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
      sceneTitle: scene.title || `Slide ${scene.order}`,
      sceneOrder: scene.order,
      text,
    });
  }
  return scripts;
}

/** Serialize collected scripts as a Markdown document. */
export function buildMarkdown(stageName: string, scripts: SceneScript[]): string {
  const lines = [`# ${stageName}`];
  for (const script of scripts) {
    if (!script.text) continue;
    lines.push('', `## ${script.sceneTitle}`, '');
    const paragraphs = script.text
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

/** Escape `&`, `<`, `>` so narration text cannot break the HTML document. */
function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Serialize collected scripts as a Word-compatible `.doc` (HTML + Word MIME). */
export function buildDocHtml(stageName: string, scripts: SceneScript[]): string {
  const body: string[] = [`<h1>${escapeHtml(stageName)}</h1>`];
  for (const script of scripts) {
    if (!script.text) continue;
    body.push(`<h2>${escapeHtml(script.sceneTitle)}</h2>`);
    for (const raw of script.text.split(/\n{2,}/)) {
      const paragraph = raw.trim();
      if (!paragraph) continue;
      body.push(`<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`);
    }
  }
  return [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    '<title>',
    escapeHtml(stageName),
    '</title>',
    '</head>',
    '<body>',
    ...body,
    '</body>',
    '</html>',
  ].join('');
}

/**
 * Build a safe download file name: `<stem>-script.<ext>`. Illegal filename
 * characters are stripped, whitespace runs collapse to a single `-`, and an
 * empty stem falls back to `script`.
 */
export function buildScriptFileName(stageName: string, ext: 'md' | 'doc'): string {
  const cleaned = stageName
    .replace(/[\u0000-\u001f\u007f\u200b-\u200c\u200e-\u200f\ufeff\\/:*?"<>|]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned ? `${cleaned}-script.${ext}` : `script.${ext}`;
}

/** Shared export hook — exposes `exportScriptDoc()` and `exportScriptMd()`. */
export function useExportScript() {
  const { t } = useI18n();

  const downloadScript = useCallback(
    (ext: 'md' | 'doc') => {
      // Read state at click time: the download is user-triggered, so there is
      // no need to subscribe the hook to the stage store on every render.
      const scenes = useStageStore.getState().scenes;
      const stage = useStageStore.getState().stage;
      const scripts = collectSceneScripts(scenes);
      if (scripts.length === 0) {
        toast.warning(t('export.nothingToExport'));
        return;
      }
      try {
        const fileName = stage?.name || 'classroom';
        const content =
          ext === 'md' ? buildMarkdown(fileName, scripts) : buildDocHtml(fileName, scripts);
        const mime = ext === 'md' ? 'text/markdown' : 'application/msword';
        const blob = new Blob([content], { type: `${mime};charset=utf-8` });
        saveAs(blob, buildScriptFileName(fileName, ext));
        toast.success(t('export.exportSuccess'));
      } catch (error) {
        log.error(`Script export failed (${ext}):`, error);
        toast.error(t('export.exportFailed'));
      }
    },
    [t],
  );

  return {
    exportScriptDoc: () => downloadScript('doc'),
    exportScriptMd: () => downloadScript('md'),
  };
}
