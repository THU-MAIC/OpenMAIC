import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseXml } from '../src/parser/XmlParser';
import { parsePicNode } from '../src/model/nodes/PicNode';
import { pictureToElement } from '../src/serializer/imageSerializer';
import { parsedToSlides } from '../src/import-pipeline';
import { minimalCtx } from './helpers';

const poster = 'data:image/png;base64,aGVsbG8=';
const bytes = new Uint8Array([1, 2, 3, 4]);
const urls: string[] = [];
afterEach(() => {
  urls.splice(0).forEach((url) => URL.revokeObjectURL(url));
  vi.restoreAllMocks();
});

function picture(legacy = '<a:videoFile r:link="old"/>', embedded = true) {
  return parsePicNode(
    parseXml(`<p:pic
    xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
    xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
    xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main">
    <p:nvPicPr><p:cNvPr id="1" name="Video"/><p:cNvPicPr/><p:nvPr>
      ${legacy}
      ${embedded ? '<p:extLst><p:ext uri="unrelated"/><p:ext uri="media"><p14:media r:embed="embedded"/></p:ext></p:extLst>' : ''}
    </p:nvPr></p:nvPicPr>
    <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm></p:spPr>
  </p:pic>`),
  );
}

async function renderMedia({
  legacy,
  embedded = true,
  oldTarget = 'NULL',
  embeddedTarget = '../media/video.mp4',
  missing = false,
}: {
  legacy?: string;
  embedded?: boolean;
  oldTarget?: string;
  embeddedTarget?: string;
  missing?: boolean;
} = {}) {
  const ctx = minimalCtx();
  ctx.slide.rels = new Map([
    ['old', { type: 'video', target: oldTarget, targetMode: 'External' }],
    ['embedded', { type: 'media', target: embeddedTarget }],
  ]);
  ctx.presentation.media = new Map(missing ? [] : [[embeddedTarget.replace('../', 'ppt/'), bytes]]);
  const result = await pictureToElement(picture(legacy, embedded), ctx, 0);
  urls.push(...ctx.mediaUrlCache.values());
  return result;
}

describe('embedded media references', () => {
  it('resolves p14:media when the legacy relationship points to NULL', async () => {
    const result = await renderMedia();
    expect(result.type).toBe('video');
    expect('blob' in result && result.blob).toMatch(/^blob:/);
    if ('blob' in result && result.blob) {
      expect(new Uint8Array(await (await fetch(result.blob)).arrayBuffer())).toEqual(bytes);
    }
  });

  it('recognizes an embedded-only video', async () => {
    const result = await renderMedia({ legacy: '' });
    expect(result.type).toBe('video');
    expect('blob' in result && result.blob).toMatch(/^blob:/);
  });

  it('recognizes embedded-only audio without treating it as video', async () => {
    const result = await renderMedia({ legacy: '', embeddedTarget: '../media/audio.mp3' });
    expect(result.type).toBe('audio');
    expect('blob' in result && result.blob).toMatch(/^blob:/);
  });

  it('preserves legacy external video support', async () => {
    const result = await renderMedia({
      embedded: false,
      oldTarget: 'https://example.com/video.mp4',
    });
    expect('blob' in result && result.blob).toBe('https://example.com/video.mp4');
  });

  it('prefers the packaged media over a legacy external URL', async () => {
    const result = await renderMedia({ oldTarget: 'https://example.com/video.mp4' });
    expect('blob' in result && result.blob).toMatch(/^blob:/);
  });

  it('resolves embedded media for an explicitly marked audio element', async () => {
    const result = await renderMedia({
      legacy: '<a:audioFile r:link="old"/>',
      embeddedTarget: '../media/audio.mp3',
    });
    expect(result.type).toBe('audio');
    expect('blob' in result && result.blob).toMatch(/^blob:/);
  });

  it('leaves missing media unresolved instead of manufacturing a URL', async () => {
    const result = await renderMedia({ missing: true });
    expect(result.type).toBe('video');
    expect('blob' in result && result.blob).toBeUndefined();
  });

  it('falls back to the legacy URL when embedded media is missing', async () => {
    const result = await renderMedia({ missing: true, oldTarget: 'https://example.com/video.mp4' });
    expect('blob' in result && result.blob).toBe('https://example.com/video.mp4');
  });

  it('does not put the video URL in the poster field when no image exists', async () => {
    const result = await renderMedia({
      embedded: false,
      oldTarget: 'https://example.com/video.mp4',
    });
    expect('src' in result && result.src).toBeUndefined();
  });
});

function deck(src = poster) {
  return {
    size: { width: 960, height: 540 },
    themeColors: [],
    slides: [
      {
        fill: { type: 'color', value: '#ffffff' },
        note: '',
        layoutElements: [],
        elements: [
          {
            type: 'video',
            left: 0,
            top: 0,
            width: 100,
            height: 100,
            order: 0,
            blob: 'https://example.com/video.mp4',
            src,
          },
        ],
      },
    ],
  } as Parameters<typeof parsedToSlides>[0];
}

describe('configurable video poster upload', () => {
  it('keeps concurrent posters distinct when uploads use filenames as storage keys', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1789441374000);
    const json = deck();
    const template = json.slides[0].elements[0];
    const contents = Array.from({ length: 12 }, (_, i) => `poster-${i}`);
    json.slides[0].elements = contents.map((content, order) => ({
      ...template,
      order,
      src: `data:image/png;base64,${Buffer.from(content).toString('base64')}`,
    }));
    const objects = new Map<string, string>();
    const [slide] = await parsedToSlides(json, {
      upload: async (blob, filename, dir) => {
        const url = `https://storage.example/${dir}/${filename}`;
        objects.set(url, await blob.text());
        return url;
      },
    });
    expect(objects.size).toBe(contents.length);
    expect(
      slide.elements.map((element) => {
        expect(element.type).toBe('video');
        return element.type === 'video' ? objects.get(element.poster!) : undefined;
      }),
    ).toEqual(contents);
  });

  it('keeps base64 when no upload callback is configured', async () => {
    const [slide] = await parsedToSlides(deck());
    expect(slide.elements[0]).toMatchObject({ type: 'video', poster });
  });

  it('awaits the configured upload and uses its returned URL', async () => {
    const upload = vi.fn(async (blob: Blob) => {
      expect(blob.type).toBe('image/png');
      expect(await blob.text()).toBe('hello');
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 'https://custom-storage.example/poster.png';
    });
    const [slide] = await parsedToSlides(deck(), { upload });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(slide.elements[0]).toMatchObject({
      poster: 'https://custom-storage.example/poster.png',
    });
  });

  it('preserves remote posters without uploading them again', async () => {
    const upload = vi.fn();
    const [slide] = await parsedToSlides(deck('https://example.com/poster.png'), { upload });
    expect(upload).not.toHaveBeenCalled();
    expect(slide.elements[0]).toMatchObject({ poster: 'https://example.com/poster.png' });
  });

  it('keeps the original poster if upload fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const upload = vi.fn(async () => {
      throw new Error('storage unavailable');
    });
    const [slide] = await parsedToSlides(deck(), { upload });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(slide.elements[0]).toMatchObject({ poster });
  });
});
