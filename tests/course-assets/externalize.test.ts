import { describe, expect, it, vi } from 'vitest';

const { uploadCourseDataUri } = vi.hoisted(() => ({
  uploadCourseDataUri: vi.fn(async (courseId: string, kind: string, value: string) =>
    `https://assets.example/courses/${courseId}/${kind}/${value.slice(5, 10)}`,
  ),
}));

vi.mock('@/lib/course-assets/client', () => ({ uploadCourseDataUri }));

import { externalizeCourseAssets } from '@/lib/course-assets/externalize';

describe('externalizeCourseAssets', () => {
  it('replaces all supported data URIs without mutating the local course', async () => {
    const stage = { id: 'course-1', data: { imageMapping: { image: 'data:image/png;base64,AAA' } } };
    const scenes = [{
      id: 'scene-1',
      narrationAudioUrl: 'data:audio/mpeg;base64,BBB',
      actions: [{ audioUrl: 'data:audio/mpeg;base64,CCC' }],
    }];

    const result = await externalizeCourseAssets('course-1', stage, scenes);

    expect(uploadCourseDataUri).toHaveBeenCalledTimes(3);
    expect(result.converted).toEqual({ images: 1, audio: 2 });
    expect(((result.stage.data as { imageMapping: Record<string, string> }).imageMapping.image)).toMatch(/^https:\/\//);
    expect(result.scenes[0].narrationAudioUrl).toMatch(/^https:\/\//);
    expect((result.scenes[0].actions as Array<{ audioUrl: string }>)[0].audioUrl).toMatch(/^https:\/\//);
    expect(stage.data.imageMapping.image).toMatch(/^data:/);
    expect(scenes[0].narrationAudioUrl).toMatch(/^data:/);
  });

  it('does not upload already external URLs', async () => {
    uploadCourseDataUri.mockClear();
    const result = await externalizeCourseAssets('course-2', { data: { imageMapping: { image: 'https://x/image.png' } } }, [{ actions: [{ audioUrl: 'https://x/audio.mp3' }] }]);
    expect(uploadCourseDataUri).not.toHaveBeenCalled();
    expect(result.converted).toEqual({ images: 0, audio: 0 });
  });
});
