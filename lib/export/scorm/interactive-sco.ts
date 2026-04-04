/**
 * interactive-sco.ts
 * Builds the HTML fragment (a <section> element) for an interactive scene.
 * The interactive HTML is embedded in an isolated <iframe srcdoc="...">.
 */
import type { Scene, InteractiveContent } from '@/lib/types/stage';

export interface InteractiveSceneMeta {
  type: 'interactive';
  sceneId: string;
}

export interface InteractiveSectionResult {
  html: string;
  meta: InteractiveSceneMeta;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Builds the HTML <section> fragment for an interactive scene.
 * The interactive HTML is sandboxed in an iframe (allow-scripts + allow-same-origin).
 */
export function buildInteractiveSection(scene: Scene, sceneIndex: number): InteractiveSectionResult {
  const content = scene.content as InteractiveContent;
  const sceneId = `scene-${sceneIndex}`;

  // Escape HTML for srcdoc attribute (must escape " and &)
  const srcdoc = (content.html ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');

  const html = `<section id="${sceneId}" class="om-scene om-interactive" data-title="${escHtml(scene.title)}" style="display:none">
  <iframe class="om-iframe"
    srcdoc="${srcdoc}"
    sandbox="allow-scripts allow-same-origin allow-forms"
    title="${escHtml(scene.title)}"></iframe>
</section>`;

  return {
    html,
    meta: { type: 'interactive', sceneId },
  };
}
