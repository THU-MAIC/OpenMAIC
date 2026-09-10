import { afterEach, describe, expect, it, vi } from 'vitest';

import { isConcreteMediaAddress } from '@/lib/media/resolve-media-ref';

const mocks = vi.hoisted(() => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:fs', () => ({ promises: { mkdir: mocks.mkdir, writeFile: mocks.writeFile } }));

import { persistClassroomMediaBytes } from '@/lib/server/classroom-media-bytes';
import { CLASSROOMS_DIR } from '@/lib/server/classroom-storage';

/**
 * Regression coverage for the agent-runtime byte persist path (#media-origin):
 * durable classroom-media references must be origin-independent RELATIVE paths
 * (`/api/classroom-media/<stageId>/media/<filename>`), never absolute URLs
 * baked from `LOCAL_MEDIA_ORIGIN` — the agent runner has no HTTP request to
 * derive an origin from, so any deployment not on localhost:3000 would persist
 * references the browser can never fetch.
 */
describe('persistClassroomMediaBytes', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns a relative classroom-media path with no baked origin', async () => {
    const ref = await persistClassroomMediaBytes({
      stageId: 'stage-owner',
      bytes: Buffer.from('real-media-bytes'),
      mime: 'image/png',
      prefix: 'generated',
    });

    // Relative, origin-independent: no scheme, host, or port anywhere.
    expect(ref).toMatch(
      /^\/api\/classroom-media\/stage-owner\/media\/generated-[a-f0-9]{64}\.png$/,
    );
    expect(ref).not.toMatch(/^https?:\/\//);
    expect(ref).not.toContain('localhost');
    expect(ref).not.toContain(':3000');
    // The browser treats it as a concrete media address and renders it raw,
    // resolving the relative path against the page origin.
    expect(isConcreteMediaAddress(ref)).toBe(true);
  });

  it('persists bytes under the stage media directory and derives the filename from content', async () => {
    const bytes = Buffer.from('real-media-bytes');
    const ref = await persistClassroomMediaBytes({
      stageId: 'stage-owner',
      bytes,
      mime: 'audio/mpeg',
      prefix: 'tts-speech-a',
      signal: new AbortController().signal,
    });

    expect(mocks.mkdir).toHaveBeenCalledWith(`${CLASSROOMS_DIR}/stage-owner/media`, {
      recursive: true,
    });
    expect(mocks.writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/tts-speech-a-[a-f0-9]{64}\.mp3$/),
      bytes,
    );
    // The same bytes always resolve to the same stable reference.
    const again = await persistClassroomMediaBytes({
      stageId: 'stage-owner',
      bytes,
      mime: 'audio/mpeg',
      prefix: 'tts-speech-a',
    });
    expect(again).toBe(ref);
  });

  it('honors a pre-aborted signal before any I/O', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      persistClassroomMediaBytes({
        stageId: 'stage-owner',
        bytes: Buffer.from('x'),
        mime: 'image/png',
        signal: controller.signal,
      }),
    ).rejects.toThrow('aborted');
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });
});
