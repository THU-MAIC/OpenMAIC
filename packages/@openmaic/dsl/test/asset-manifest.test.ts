import { describe, expect, it } from 'vitest';
import {
  enumerateAssetManifest,
  type AssetManifestDocument,
  type Scene,
  type Slide,
  type Stage,
} from '@openmaic/dsl';

/** A minimal slide carrier: only the slots the enumeration reads. */
function slideWith(elements: Slide['elements'], background?: Slide['background']): Slide {
  return { id: 'slide-1', elements, ...(background ? { background } : {}) } as Slide;
}

function imageElement(id: string, src: string): Slide['elements'][number] {
  return { id, type: 'image', src } as Slide['elements'][number];
}

function videoElement(
  id: string,
  fields: { src?: string; mediaRef?: string; poster?: string },
): Slide['elements'][number] {
  return { id, type: 'video', autoplay: false, ...fields } as Slide['elements'][number];
}

function slideScene(
  id: string,
  canvas: Slide,
  extra: Partial<Scene> = {},
): AssetManifestDocument['scenes'][number] {
  return {
    id,
    stageId: 'stage-1',
    title: id,
    order: 0,
    type: 'slide',
    content: { type: 'slide', canvas },
    ...extra,
  } as AssetManifestDocument['scenes'][number];
}

function documentWith(
  scenes: AssetManifestDocument['scenes'],
  stage: Partial<Pick<Stage, 'whiteboard' | 'videoManifest'>> = {},
): AssetManifestDocument {
  return { stage: stage as AssetManifestDocument['stage'], scenes };
}

describe('enumerateAssetManifest — reference categories', () => {
  it('enumerates every reference category with its kind', () => {
    const document = documentWith(
      [
        slideScene(
          'scene-1',
          slideWith(
            [
              imageElement('img-1', 'ast_image'),
              { id: 'aud-1', type: 'audio', src: 'ast_slide_audio' } as Slide['elements'][number],
              videoElement('vid-1', {
                src: 'ast_video_src',
                mediaRef: 'ast_video_ref',
                poster: 'ast_poster',
              }),
            ],
            { type: 'image', image: { src: 'ast_background', size: 'cover' } },
          ),
          {
            whiteboards: [slideWith([imageElement('wb-img', 'ast_scene_wb')])],
            actions: [
              { id: 'a1', type: 'speech', text: 'hi', audioId: 'ast_narration' },
              { id: 'a2', type: 'spotlight', elementId: 'img-1' },
            ] as Scene['actions'],
          },
        ),
      ],
      {
        whiteboard: [slideWith([imageElement('stage-wb-img', 'ast_stage_wb')])],
        videoManifest: { ast_manifest_video: { type: 'video', prompt: 'trailer' } },
      },
    );

    const manifest = enumerateAssetManifest(document);
    const kindByRef = new Map(manifest.entries.map((entry) => [entry.ref, entry.kind]));

    expect(kindByRef).toEqual(
      new Map([
        ['ast_stage_wb', 'image'],
        ['ast_background', 'background'],
        ['ast_image', 'image'],
        ['ast_slide_audio', 'audio'],
        ['ast_video_src', 'video'],
        ['ast_video_ref', 'video'],
        ['ast_poster', 'poster'],
        ['ast_scene_wb', 'image'],
        ['ast_narration', 'audio'],
        ['ast_manifest_video', 'video'],
      ]),
    );
  });

  it('skips empty slots and non-speech actions', () => {
    const document = documentWith([
      slideScene(
        'scene-1',
        slideWith([
          videoElement('vid-1', {}),
          { id: 't1', type: 'text', content: 'hello' } as Slide['elements'][number],
        ]),
        { actions: [{ id: 'a1', type: 'speech', text: 'no audio yet' }] as Scene['actions'] },
      ),
    ]);

    expect(enumerateAssetManifest(document).entries).toEqual([]);
  });

  it('enumerates legacy placeholder refs and concrete URLs verbatim', () => {
    // The manifest is the reference set the document touches, not a resolution
    // result: legacy placeholders and concrete URLs both appear, and the
    // export paths decide which of them resolve to archivable bytes.
    const document = documentWith([
      slideScene(
        'scene-1',
        slideWith([
          imageElement('img-1', 'gen_img_1'),
          imageElement('img-2', 'https://cdn.example/photo.jpg'),
        ]),
      ),
    ]);

    const refs = enumerateAssetManifest(document).entries.map((entry) => entry.ref);
    expect(refs).toEqual(['gen_img_1', 'https://cdn.example/photo.jpg']);
  });
});

describe('enumerateAssetManifest — orphan exclusion and dedup', () => {
  it('contains exactly the document references -- a ref the document drops disappears', () => {
    // Orphan exclusion is structural: the enumeration reads the document, not
    // any storage table, so a stored row nothing references can never appear.
    const withRef = documentWith([slideScene('scene-1', slideWith([imageElement('i', 'ast_a')]))]);
    const withoutRef = documentWith([slideScene('scene-1', slideWith([]))]);

    expect(enumerateAssetManifest(withRef).entries.map((entry) => entry.ref)).toEqual(['ast_a']);
    expect(enumerateAssetManifest(withoutRef).entries).toEqual([]);
  });

  it('keeps one entry for repeated occurrences of the same ref and kind', () => {
    const document = documentWith(
      [
        slideScene('scene-1', slideWith([imageElement('i1', 'ast_shared')])),
        slideScene('scene-2', slideWith([imageElement('i2', 'ast_shared')])),
      ],
      { whiteboard: [slideWith([imageElement('i3', 'ast_shared')])] },
    );

    const entries = enumerateAssetManifest(document).entries;
    expect(entries.filter((entry) => entry.ref === 'ast_shared')).toHaveLength(1);
    expect(entries[0]).toMatchObject({ ref: 'ast_shared', kind: 'image' });
  });

  it('keeps one entry per ref and kind when a structurally valid ref spans roles', () => {
    const document = documentWith([
      slideScene('scene-1', slideWith([imageElement('i1', 'ast_cross_kind')]), {
        actions: [
          { id: 'a1', type: 'speech', text: 'shared', audioId: 'ast_cross_kind' },
        ] as Scene['actions'],
      }),
    ]);

    expect(enumerateAssetManifest(document).entries).toEqual([
      { ref: 'ast_cross_kind', kind: 'image' },
      { ref: 'ast_cross_kind', kind: 'audio' },
    ]);
  });

  it('orders entries in document order', () => {
    const document = documentWith(
      [
        slideScene('scene-1', slideWith([imageElement('i1', 'ast_b')])),
        slideScene('scene-2', slideWith([imageElement('i2', 'ast_c')])),
      ],
      { whiteboard: [slideWith([imageElement('i3', 'ast_a')])] },
    );

    expect(enumerateAssetManifest(document).entries.map((entry) => entry.ref)).toEqual([
      'ast_a',
      'ast_b',
      'ast_c',
    ]);
  });
});

describe('enumerateAssetManifest — reference counts', () => {
  it('counts a video element once for src+mediaRef but its poster separately', () => {
    const document = documentWith([
      slideScene(
        'scene-1',
        slideWith([videoElement('vid-1', { src: 'ast_v', mediaRef: 'ast_v', poster: 'ast_p' })]),
      ),
    ]);

    const { referenceCounts } = enumerateAssetManifest(document);
    expect(referenceCounts.get('ast_v')).toBe(1);
    expect(referenceCounts.get('ast_p')).toBe(1);
  });

  it('counts every owning element across scopes', () => {
    const document = documentWith(
      [
        slideScene('scene-1', slideWith([imageElement('i1', 'ast_img')])),
        slideScene('scene-2', slideWith([imageElement('i2', 'ast_img')])),
      ],
      { whiteboard: [slideWith([imageElement('i3', 'ast_img')])] },
    );

    expect(enumerateAssetManifest(document).referenceCounts.get('ast_img')).toBe(3);
  });

  it('does not collapse owners when scene and element ids repeat', () => {
    const document = documentWith([
      slideScene('duplicate-scene', slideWith([imageElement('duplicate-element', 'ast_img')])),
      slideScene('duplicate-scene', slideWith([imageElement('duplicate-element', 'ast_img')])),
    ]);

    expect(enumerateAssetManifest(document).referenceCounts.get('ast_img')).toBe(2);
  });

  it('enumerates video-manifest refs without counting the index as another owner', () => {
    const document = documentWith(
      [slideScene('scene-1', slideWith([videoElement('vid-1', { mediaRef: 'ast_video' })]))],
      {
        videoManifest: {
          ast_video: { type: 'video', prompt: 'inserted' },
          ast_manifest_only: { type: 'video', prompt: 'not inserted yet' },
        },
      },
    );

    const manifest = enumerateAssetManifest(document);
    expect(manifest.entries.map((entry) => entry.ref)).toEqual(['ast_video', 'ast_manifest_only']);
    expect(manifest.referenceCounts.get('ast_video')).toBe(1);
    expect(manifest.referenceCounts.has('ast_manifest_only')).toBe(false);
  });
});

describe('enumerateAssetManifest — metadata', () => {
  it('propagates metadata from the injected lookup, omitting unknown fields', () => {
    const document = documentWith([
      slideScene('scene-1', slideWith([imageElement('i1', 'ast_img')]), {
        actions: [
          { id: 'a1', type: 'speech', text: 'hi', audioId: 'ast_audio' },
        ] as Scene['actions'],
      }),
    ]);

    const manifest = enumerateAssetManifest(document, {
      metadata: (ref, kind) =>
        kind === 'audio'
          ? { durationSeconds: 2.5, voice: 'alloy', mimeType: 'audio/mpeg' }
          : ref === 'ast_img'
            ? { byteSize: 1024, mimeType: 'image/png', prompt: 'a diagram' }
            : undefined,
    });

    expect(manifest.entries).toEqual([
      {
        ref: 'ast_img',
        kind: 'image',
        byteSize: 1024,
        mimeType: 'image/png',
        prompt: 'a diagram',
      },
      {
        ref: 'ast_audio',
        kind: 'audio',
        durationSeconds: 2.5,
        voice: 'alloy',
        mimeType: 'audio/mpeg',
      },
    ]);
  });

  it('leaves entries metadata-free when no lookup is supplied', () => {
    const document = documentWith([
      slideScene('scene-1', slideWith([imageElement('i1', 'ast_img')])),
    ]);

    expect(enumerateAssetManifest(document).entries).toEqual([{ ref: 'ast_img', kind: 'image' }]);
  });
});
