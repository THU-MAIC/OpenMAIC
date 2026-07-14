import { describe, expect, it } from 'vitest';
import {
  compileVideoTimeline,
  emitManifest,
  emitManifestJson,
  VideoTimelineSchema,
  VIDEO_TIMELINE_SCHEMA,
  VIDEO_TIMELINE_VERSION,
} from '@/lib/video-export';
import { NO_ASSETS, slide, speech, stubProbe } from './helpers';

function sampleIr() {
  return compileVideoTimeline(
    { stage: { id: 'stg', name: 'Demo' }, scenes: [slide('s', [speech('a', 'hi')])] },
    { timing: stubProbe({ a: 2000 }), assets: NO_ASSETS },
  );
}

describe('emitManifest', () => {
  it('validates the IR against the schema and returns it stamped', () => {
    const manifest = emitManifest(sampleIr());
    expect(manifest.schema).toBe(VIDEO_TIMELINE_SCHEMA);
    expect(manifest.version).toBe(VIDEO_TIMELINE_VERSION);
    expect(() => VideoTimelineSchema.parse(manifest)).not.toThrow();
  });

  it('produces JSON-serializable output', () => {
    const json = emitManifestJson(sampleIr());
    const round = JSON.parse(json);
    expect(round.schema).toBe(VIDEO_TIMELINE_SCHEMA);
    expect(round.scenes[0].narration[0].text).toBe('hi');
  });

  it('throws on a malformed IR (schema is enforced)', () => {
    const bad = { ...sampleIr(), version: 999 } as never;
    expect(() => emitManifest(bad)).toThrow();
  });
});
