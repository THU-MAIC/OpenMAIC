// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMediaLibrary,
  firstLinkedImage,
} from '@/lib/standalone-player/playback/media-library';
import type { ManifestScene } from '@/lib/export/classroom-zip-types';

const BYTES = Uint8Array.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0]);

function documentWith(table: unknown, blocks: Record<string, string>): Document {
  const doc = document.implementation.createHTMLDocument('x');
  const tableElement = doc.createElement('script');
  tableElement.type = 'application/json';
  tableElement.id = 'openmaic-media';
  tableElement.textContent = typeof table === 'string' ? table : JSON.stringify(table);
  doc.body.append(tableElement);
  for (const [id, base64] of Object.entries(blocks)) {
    const block = doc.createElement('script');
    block.type = 'application/octet-stream';
    block.id = id;
    block.textContent = base64;
    doc.body.append(block);
  }
  return doc;
}

const created: Blob[] = [];
beforeEach(() => {
  created.length = 0;
  let next = 0;
  URL.createObjectURL = vi.fn((blob: Blob) => {
    created.push(blob);
    return `blob:test/${++next}`;
  });
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('createMediaLibrary', () => {
  it('decodes an embedded block into a typed Blob URL once and caches it', async () => {
    const doc = documentWith(
      { 'audio/audio-1.mp3': { mimeType: 'audio/mpeg', embedded: 'openmaic-media-1' } },
      { 'openmaic-media-1': Buffer.from(BYTES).toString('base64') },
    );
    const library = createMediaLibrary(doc);
    expect(library.has('audio/audio-1.mp3')).toBe(true);
    const url = library.resolve('audio/audio-1.mp3');
    expect(url).toBe('blob:test/1');
    expect(library.resolve('audio/audio-1.mp3')).toBe(url);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(created[0].type).toBe('audio/mpeg');
    expect(new Uint8Array(await created[0].arrayBuffer())).toEqual(BYTES);
    library.dispose();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(url);
  });

  it('uses a src entry as is (media shipped next to the page)', () => {
    const library = createMediaLibrary(
      documentWith({ 'media/asset-1.mp4': { src: 'media/asset-1.mp4' } }, {}),
    );
    expect(library.resolve('media/asset-1.mp4')).toBe('media/asset-1.mp4');
  });

  it('returns undefined for unknown keys, missing blocks, corrupt base64 and a corrupt table', () => {
    const library = createMediaLibrary(
      documentWith(
        {
          missing: { mimeType: 'audio/mpeg', embedded: 'nowhere' },
          corrupt: { mimeType: 'audio/mpeg', embedded: 'openmaic-media-1' },
        },
        { 'openmaic-media-1': '@@not base64@@' },
      ),
    );
    expect(library.resolve(undefined)).toBeUndefined();
    expect(library.resolve('unknown')).toBeUndefined();
    expect(library.has('missing')).toBe(false);
    expect(library.resolve('missing')).toBeUndefined();
    expect(library.resolve('corrupt')).toBeUndefined();
    expect(library.resolve('__proto__')).toBeUndefined();
    expect(createMediaLibrary(documentWith('{not json', {})).resolve('x')).toBeUndefined();
  });

  it('counts only linked files that fail to load as missing, and notifies once', () => {
    const library = createMediaLibrary(
      documentWith(
        {
          'audio/audio-1.mp3': { mimeType: 'audio/mpeg', src: 'audio/audio-1.mp3' },
          embedded: { mimeType: 'audio/mpeg', embedded: 'openmaic-media-1' },
        },
        { 'openmaic-media-1': Buffer.from(BYTES).toString('base64') },
      ),
    );
    const listener = vi.fn();
    library.subscribe(listener);
    library.reportError('embedded');
    library.reportError('unknown');
    library.reportError(undefined);
    expect(library.linkedMediaMissing()).toBe(false);
    library.reportError('audio/audio-1.mp3');
    library.reportError('audio/audio-1.mp3');
    expect(library.linkedMediaMissing()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('probes one linked file as the player opens and flags a missing folder', () => {
    const doc = documentWith(
      {
        embedded: { mimeType: 'audio/mpeg', embedded: 'openmaic-media-1' },
        'media/asset-1.mp4': { mimeType: 'video/mp4', src: 'media/asset-1.mp4' },
        'audio/audio-1.mp3': { mimeType: 'audio/mpeg', src: 'audio/audio-1.mp3' },
      },
      {},
    );
    const created: HTMLMediaElement[] = [];
    const createElement = doc.createElement.bind(doc);
    vi.spyOn(doc, 'createElement').mockImplementation(((tag: string) => {
      const element = createElement(tag);
      if (element instanceof HTMLMediaElement) created.push(element);
      return element;
    }) as typeof doc.createElement);
    const library = createMediaLibrary(doc);
    const listener = vi.fn();
    library.subscribe(listener);
    library.probeLinkedMedia();
    library.probeLinkedMedia(); // one probe at a time
    expect(created).toHaveLength(1);
    expect(created[0].tagName).toBe('VIDEO');
    expect(created[0].getAttribute('src')).toBe('media/asset-1.mp4');
    expect(created[0].preload).toBe('metadata');
    created[0].dispatchEvent(new Event('error'));
    expect(library.linkedMediaMissing()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(created[0].hasAttribute('src')).toBe(false);
    library.probeLinkedMedia(); // already known missing
    expect(created).toHaveLength(1);
  });

  it('a probe that loads leaves the library healthy; files without linked media never probe', () => {
    const doc = documentWith({ 'audio/a.mp3': { mimeType: 'audio/mpeg', src: 'audio/a.mp3' } }, {});
    const spy = vi.spyOn(doc, 'createElement');
    const library = createMediaLibrary(doc);
    library.probeLinkedMedia();
    const probe = spy.mock.results[0].value as HTMLAudioElement;
    expect(probe.tagName).toBe('AUDIO');
    probe.dispatchEvent(new Event('loadedmetadata'));
    probe.dispatchEvent(new Event('error'));
    expect(library.linkedMediaMissing()).toBe(false);

    const embeddedOnly = documentWith({ k: { embedded: 'openmaic-media-1' } }, {});
    const none = vi.spyOn(embeddedOnly, 'createElement');
    createMediaLibrary(embeddedOnly).probeLinkedMedia();
    expect(none).not.toHaveBeenCalled();
  });

  it('probes a linked slide image when the media table links no file', () => {
    const doc = documentWith({ k: { embedded: 'openmaic-media-1' } }, {});
    const spy = vi.spyOn(doc, 'createElement');
    const library = createMediaLibrary(doc, { linkedImage: 'images/image-1.png' });
    library.probeLinkedMedia();
    const probe = spy.mock.results[0].value as HTMLImageElement;
    expect(probe.tagName).toBe('IMG');
    expect(probe.getAttribute('src')).toBe('images/image-1.png');
    probe.dispatchEvent(new Event('error'));
    expect(library.linkedMediaMissing()).toBe(true);

    // A linked clip is preferred over the image.
    const both = documentWith({ a: { mimeType: 'audio/mpeg', src: 'audio/a.mp3' } }, {});
    const bothSpy = vi.spyOn(both, 'createElement');
    createMediaLibrary(both, { linkedImage: 'images/image-1.png' }).probeLinkedMedia();
    expect((bothSpy.mock.results[0].value as HTMLElement).tagName).toBe('AUDIO');
  });
});

describe('linked slide image failures', () => {
  const failing = (doc: Document, tag: string, attrs: Record<string, string>) => {
    const el = doc.createElementNS(
      tag === 'image' ? 'http://www.w3.org/2000/svg' : 'http://www.w3.org/1999/xhtml',
      tag,
    );
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    doc.body.append(el);
    el.dispatchEvent(new Event('error'));
  };

  it('reports a slide <img> or SVG <image> that fails to load from a linked path', () => {
    for (const [tag, attrs] of [
      ['img', { src: 'images/image-1.png' }],
      ['image', { href: 'images/image-2.png' }],
    ] as const) {
      const doc = documentWith({ a: { mimeType: 'audio/mpeg', src: 'audio/a.mp3' } }, {});
      const library = createMediaLibrary(doc);
      const listener = vi.fn();
      library.subscribe(listener);
      failing(doc, tag, attrs);
      expect(library.linkedMediaMissing()).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);
    }
  });

  it('ignores inline images and stops listening once disposed', () => {
    const doc = documentWith({}, {});
    const library = createMediaLibrary(doc);
    failing(doc, 'img', { src: 'data:image/png;base64,AAAA' });
    failing(doc, 'img', { src: 'blob:null/1' });
    failing(doc, 'img', { src: 'https://cdn.example/a.png' });
    expect(library.linkedMediaMissing()).toBe(false);
    library.dispose();
    failing(doc, 'img', { src: 'images/image-1.png' });
    expect(library.linkedMediaMissing()).toBe(false);
  });
});

describe('firstLinkedImage', () => {
  const slide = (elements: unknown[], background?: unknown): ManifestScene =>
    ({
      type: 'slide',
      title: 's',
      order: 0,
      content: { type: 'slide', canvas: { id: 's', elements, background } },
    }) as unknown as ManifestScene;

  it('finds the first image, background or poster named by relative path', () => {
    expect(firstLinkedImage([])).toBeUndefined();
    expect(
      firstLinkedImage([
        slide([{ type: 'image', src: 'data:image/png;base64,AAAA' }]),
        slide([{ type: 'video', poster: 'images/image-2.jpg' }]),
      ]),
    ).toBe('images/image-2.jpg');
    expect(
      firstLinkedImage([
        slide([{ type: 'image', src: 'images/image-1.png' }], {
          type: 'image',
          image: { src: 'images/image-3.png' },
        }),
      ]),
    ).toBe('images/image-3.png');
    for (const src of ['', 'blob:x', 'https://a.example/x.png', '/abs.png']) {
      expect(firstLinkedImage([slide([{ type: 'image', src }])])).toBeUndefined();
    }
  });
});
