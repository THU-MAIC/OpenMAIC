import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan } from '@hyperframes/producer/distributed';
import { strToU8, zipSync } from 'fflate';
import { expect, it, vi } from 'vitest';
import { LocalDiskArtifactStore } from '../src/artifact-store.js';
import type { RenderEvent } from '../src/events.js';
import { RenderCoordinator } from '../src/render-coordinator.js';
import { InProcessExecutor } from '../src/render-executor.js';
import { Semaphore } from '../src/semaphore.js';
import { missingFontProjectHtml as html } from './fixtures/missing-font-project.js';
import { createMemoryJobStore } from './support/fakes.js';

const executable = process.env.PRODUCER_HEADLESS_SHELL_PATH;

it.skipIf(!executable)(
  'renders a two-chunk export with missing fonts under the egress lockdown using real Producer',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'offline-font-producer-'));
    const fetches: string[] = [];
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
        return originalFetch(input, init);
      fetches.push(url.hostname);
      return Promise.reject(new Error('External fetch blocked by the offline test'));
    });
    vi.stubEnv('RENDER_SERVICE_NO_LISTEN', 'true');
    vi.stubEnv('RENDER_EGRESS_LOCKDOWN_ACTIVE', 'true');
    try {
      const { createApp } = await import('../src/main.js');
      const baseline = await mkdtemp(join(root, 'baseline-'));
      await writeFile(join(baseline, 'index.html'), html);
      await expect(
        plan(
          baseline,
          {
            fps: 24,
            width: 320,
            height: 180,
            format: 'mp4',
            failClosedFontFetch: true,
            rejectOnSystemFonts: true,
          },
          join(root, 'baseline-plan'),
        ),
      ).rejects.toThrow(/Google Fonts CSS fetch for ".+" failed/);
      expect(fetches.splice(0)).toContain('fonts.googleapis.com');

      const jobs = createMemoryJobStore();
      const artifacts = new LocalDiskArtifactStore();
      const events: RenderEvent[] = [];
      const planDir = join(root, 'finished-plan');
      const executor = new InProcessExecutor({
        chunkExecution: { planDir, chunkCount: 2, chunkSizeFrames: 12, maxParallelChunks: 1 },
      });
      const coordinator = new RenderCoordinator(executor, jobs, artifacts, {
        onEvent: (event) => events.push(event),
      });
      const app = createApp({
        jobs,
        artifacts,
        coordinator,
        extractionGate: new Semaphore(1),
        makeProjectDir: () => mkdtemp(join(root, 'render-')),
      });
      const form = new FormData();
      form.set(
        'project',
        new File([Buffer.from(zipSync({ 'index.html': strToU8(html) }))], 'export.zip'),
      );
      form.set('fps', '24');
      form.set('quality', 'draft');
      const headers = {
        'x-openmaic-render-owner': 'offline-test',
        'x-openmaic-client': 'offline-test',
      };
      const response = await app.request('/owner-bound/render', {
        method: 'POST',
        body: form,
        headers,
      });
      expect(response.status).toBe(202);
      const { jobId } = (await response.json()) as { jobId: string };
      await vi.waitFor(
        async () => {
          expect(['succeeded', 'failed', 'cancelled']).toContain((await jobs.get(jobId))?.status);
        },
        { timeout: 45_000, interval: 100 },
      );
      const job = await jobs.get(jobId);
      expect(job?.status, job?.error).toBe('succeeded');
      expect(fetches).toEqual([]);
      expect(events).toContainEqual({
        event: 'render_font_fallback',
        jobId,
        fontFallbackCount: 2,
        fontFallbackFamilies: ['LXGW WenKai', 'MissingProbeFace'],
      });
      const compiled = await readFile(join(planDir, 'compiled/index.html'), 'utf8');
      // The authored stacks reach Chromium unchanged; only bundled faces are added.
      expect(compiled).toContain('font-family: MissingProbeFace, "OpenMAIC Inter", sans-serif;');
      expect(compiled).toContain('font-family: "LXGW WenKai", sans-serif;');
      expect(compiled).toContain('font: 700 16px MissingShorthand, sans-serif;');
      expect(compiled).toMatch(/font-family:\s*"OpenMAIC Inter";/);
      expect(compiled).toMatch(/font-family:\s*"Inter";[^}]+src:\s*url\("data:font\/woff2;base64,/);
      expect(compiled).toMatch(
        /font-family:\s*"Roboto";[^}]+src:\s*url\("data:font\/woff2;base64,/,
      );
      // An alias such as Calibri gets a bundled face and is not reported.
      expect(compiled).toMatch(
        /font-family:\s*"Calibri";[^}]+src:\s*url\("data:font\/woff2;base64,/,
      );
      const chunks = JSON.parse(await readFile(join(planDir, 'meta/chunks.json'), 'utf8'));
      expect(chunks).toMatchObject([
        { startFrame: 0, endFrame: 12 },
        { startFrame: 12, endFrame: 24 },
      ]);
      const download = await app.request(`/owner-bound/render/${jobId}/download`, { headers });
      expect(download.status).toBe(200);
      const movie = join(root, 'download.mp4');
      await writeFile(movie, Buffer.from(await download.arrayBuffer()));
      const frames = execFileSync(
        'ffprobe',
        [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-show_entries',
          'stream=nb_frames',
          '-of',
          'default=noprint_wrappers=1:nokey=1',
          movie,
        ],
        { encoding: 'utf8' },
      );
      expect(frames.trim()).toBe('24');
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
