/**
 * Hyperframes emitter — `VideoTimeline` IR → a self-contained composition project.
 *
 * The IR is the contract (issue #864); this pure emitter is a downstream
 * consumer (#865) that renders it to the files `npx hyperframes render` needs:
 * a single `index.html` whose stage is one Hyperframes composition, driven by one
 * `paused` GSAP timeline registered on `window.__timelines`. Because every IR
 * time is already absolute on the global playback clock (the compiler runs one
 * cursor across all scenes), the whole classroom is a single flat composition —
 * scene base frames and video clips are `class="clip"` elements laid out with
 * `data-start`/`data-duration`, and effects are overlay DOM the timeline reveals.
 *
 * This module emits **text only** (HTML/JS/JSON/SRT/VTT strings); the binary
 * assets it references by relative path (`frames/…`, `audio/…`, `media/…`, and
 * the vendored GSAP) are collected and written by the app-side packaging layer,
 * so the emitter stays pure and string-snapshot testable.
 *
 * Determinism red-lines (enforced downstream by `hyperframes lint`): GSAP is
 * vendored locally (no CDN), no `Date.now`/`Math.random`/network at render time,
 * explicit root `data-duration`, no infinite repeats.
 *
 * Pure: depends only on the IR, the subtitle serializer, and the effect emitter.
 */
import type { VideoTimeline, VideoTimelineScene } from '../ir';
import { emitManifestJson } from '../passes/emit';
import { toSrt, toVtt } from '../subtitles';
import { EASE_DEFS, emitEffect } from './effects';
import { escapeHtml, sec } from './format';

/** A file in the emitted project: a relative path and its text content. */
export interface EmittedFile {
  path: string;
  content: string;
}

export interface EmitHyperframesOptions {
  /** Render width in px. Default 1920. Height is derived from the IR's 16:9 aspect. */
  width?: number;
  /** Render height in px. Default derived from `width` at 16:9. */
  height?: number;
  /** Composition id used for the root `data-composition-id` and the timeline key. Default `openmaic`. */
  compositionId?: string;
  /** Relative path the emitted HTML loads GSAP from. Default `assets/vendor/gsap.min.js`. */
  gsapVendorPath?: string;
  /** Manifest filename. Default `openmaic-video-manifest.json`. */
  manifestPath?: string;
}

export interface EmittedProject {
  files: EmittedFile[];
  width: number;
  height: number;
  compositionId: string;
  totalDurationMs: number;
  /** Where the emitted HTML expects the vendored GSAP — the packaging layer fills it. */
  gsapVendorPath: string;
}

const DEFAULT_WIDTH = 1920;
const DEFAULT_GSAP_PATH = 'assets/vendor/gsap.min.js';
const DEFAULT_MANIFEST = 'openmaic-video-manifest.json';

/**
 * Directory the collected binary assets live under in the export zip. The
 * compiler's asset plan uses bare paths (`frames/…`, `audio/…`, `media/…`); the
 * project places them all under `assets/` (matching the artifact layout and the
 * vendored GSAP at `assets/vendor/`). The packaging layer writes each plan blob
 * at this same `assets/<planPath>`, so HTML references and zip entries agree.
 */
export const ASSETS_DIR = 'assets';

/** Map a compiler asset-plan path to its zip-relative URL under `assets/`. */
export function assetUrl(planPath: string): string {
  return `${ASSETS_DIR}/${planPath}`;
}

/** The base layer for one scene: a slide-snapshot `<img>` clip, or a placeholder card. */
function renderBase(scene: VideoTimelineScene): string {
  const start = sec(scene.startMs);
  const duration = sec(scene.durationMs);
  const id = `scene-${scene.index + 1}-base`;
  const clip = `id="${id}" class="clip" data-start="${start}" data-duration="${duration}" data-track-index="0"`;
  if (scene.base.kind === 'slide-snapshot' && scene.base.assetRef) {
    return `<img ${clip} src="${escapeHtml(assetUrl(scene.base.assetRef))}" alt="" style="position:absolute;left:0;top:0;width:100%;height:100%;object-fit:contain" />`;
  }
  const reason = scene.base.reason ? escapeHtml(scene.base.reason) : '';
  return [
    `<div ${clip} style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;background:#0f172a;color:#e2e8f0;font-family:system-ui,sans-serif;text-align:center;padding:8%">`,
    `  <div style="font-size:2.2vw;font-weight:700">${escapeHtml(scene.title)}</div>`,
    reason ? `  <div style="font-size:1.2vw;color:#94a3b8;max-width:70%">${reason}</div>` : '',
    `</div>`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** A `play_video` clip, positioned at the target element's geometry (0–100 space). */
function renderVideo(scene: VideoTimelineScene): string[] {
  return scene.videos
    .filter((v) => v.present && v.assetRef)
    .map((v, i) => {
      const start = sec(v.startMs);
      const duration = sec(v.durationMs);
      const id = `scene-${scene.index + 1}-video-${i + 1}`;
      const clip = `id="${id}" class="clip" data-start="${start}" data-duration="${duration}" data-track-index="1"`;
      const g = v.geometry;
      const style = g
        ? `position:absolute;left:${g.x}%;top:${g.y}%;width:${g.w}%;height:${g.h}%;transform:rotate(${v.rotate}deg);object-fit:contain`
        : `position:absolute;left:0;top:0;width:100%;height:100%;object-fit:contain`;
      // data-has-audio: the clip contributes its own soundtrack, mixed at encode.
      return `<video ${clip} src="${escapeHtml(assetUrl(v.assetRef!))}" data-has-audio="true" style="${style}" playsinline></video>`;
    });
}

/** Narration `<audio>` clips (present ones); the engine mixes them at encode time. */
function renderNarration(scene: VideoTimelineScene): string[] {
  return scene.narration
    .filter((seg) => seg.audio.present && seg.audio.assetRef)
    .map((seg, i) => {
      const start = sec(seg.startMs);
      const duration = sec(seg.durationMs);
      const id = `scene-${scene.index + 1}-audio-${i + 1}`;
      return `<audio id="${id}" class="clip" data-start="${start}" data-duration="${duration}" data-track-index="2" src="${escapeHtml(assetUrl(seg.audio.assetRef!))}" data-volume="1"></audio>`;
    });
}

function renderReadme(project: {
  compositionId: string;
  width: number;
  height: number;
  totalDurationMs: number;
  gsapVendorPath: string;
  manifestPath: string;
  stageName: string;
}): string {
  const seconds = (project.totalDurationMs / 1000).toFixed(1);
  return `# ${project.stageName} — OpenMAIC video export

Self-contained [Hyperframes](https://github.com/heygen-com/hyperframes) composition
for the classroom **${project.stageName}**. Everything needed to render is in this
folder — no network access, no CDN.

- \`index.html\` — the composition (one \`data-composition-id="${project.compositionId}"\` stage, one paused GSAP timeline on \`window.__timelines\`).
- \`${project.manifestPath}\` — the \`VideoTimeline\` manifest / export report (scenes, timing, assets, diagnostics).
- \`subtitles.srt\` / \`subtitles.vtt\` — narration subtitles.
- \`assets/frames\`, \`assets/audio\`, \`assets/media\` — slide snapshots, narration audio, embedded video clips.
- \`${project.gsapVendorPath}\` — vendored GSAP (determinism: no CDN at render time).

## Render

\`\`\`bash
npx hyperframes preview                       # scrub locally in the browser
npx hyperframes render --output video.mp4 --resolution ${project.width}x${project.height}
\`\`\`

Duration: ~${seconds}s at ${project.width}×${project.height}.

## Verify

\`\`\`bash
npx hyperframes lint                          # no CDN, no non-deterministic APIs, explicit durations
\`\`\`
`;
}

/**
 * Emit the Hyperframes project for a compiled {@link VideoTimeline}. Returns the
 * text files (HTML/manifest/subtitles/README) plus the metadata the packaging
 * layer needs to place the binary assets and the vendored GSAP.
 */
export function emitHyperframes(
  ir: VideoTimeline,
  options: EmitHyperframesOptions = {},
): EmittedProject {
  const width = options.width ?? DEFAULT_WIDTH;
  const height =
    options.height ?? Math.round(width * (ir.canvas.pixelBase.height / ir.canvas.pixelBase.width));
  const compositionId = options.compositionId ?? 'openmaic';
  const gsapVendorPath = options.gsapVendorPath ?? DEFAULT_GSAP_PATH;
  const manifestPath = options.manifestPath ?? DEFAULT_MANIFEST;
  const totalSec = sec(ir.totalDurationMs);

  const sceneHtml: string[] = [];
  const effectHtml: string[] = [];
  const statements: string[] = [];

  for (const scene of ir.scenes) {
    sceneHtml.push(`<!-- scene ${scene.index + 1}: ${escapeHtml(scene.title)} -->`);
    sceneHtml.push(renderBase(scene));
    sceneHtml.push(...renderVideo(scene));
    sceneHtml.push(...renderNarration(scene));

    for (const effect of scene.effects) {
      const id = `fx-${scene.index}-${effect.actionIndex}`;
      const emitted = emitEffect(effect, id, { width, height });
      if (emitted.html) effectHtml.push(emitted.html);
      statements.push(...emitted.statements);
    }
  }

  // Extend the timeline to the full composition length even if the last tween
  // ends earlier, so clips (esp. video/audio) are not cut short.
  statements.push(`tl.set({}, {}, ${totalSec});`);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(ir.stage.name)} — OpenMAIC video</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #000; }
  #${compositionId} { font-family: system-ui, sans-serif; }
</style>
</head>
<body>
<div id="${compositionId}" data-composition-id="${compositionId}" data-start="0" data-duration="${totalSec}" data-width="${width}" data-height="${height}" style="position:relative;width:${width}px;height:${height}px;overflow:hidden;background:#000">
${sceneHtml.filter(Boolean).join('\n')}
${effectHtml.join('\n')}
</div>
<script src="${escapeHtml(gsapVendorPath)}"></script>
<script>
${EASE_DEFS}
var tl = gsap.timeline({ paused: true });
${statements.join('\n')}
window.__timelines = window.__timelines || {};
window.__timelines[${JSON.stringify(compositionId)}] = tl;
</script>
</body>
</html>
`;

  const files: EmittedFile[] = [
    { path: 'index.html', content: html },
    { path: manifestPath, content: emitManifestJson(ir) },
    { path: 'subtitles.srt', content: toSrt(ir.subtitles) },
    { path: 'subtitles.vtt', content: toVtt(ir.subtitles) },
    {
      path: 'README.md',
      content: renderReadme({
        compositionId,
        width,
        height,
        totalDurationMs: ir.totalDurationMs,
        gsapVendorPath,
        manifestPath,
        stageName: ir.stage.name,
      }),
    },
  ];

  return {
    files,
    width,
    height,
    compositionId,
    totalDurationMs: ir.totalDurationMs,
    gsapVendorPath,
  };
}
