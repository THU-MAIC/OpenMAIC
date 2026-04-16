import { describe, test, expect } from 'vitest';
import { rewriteAudioRefsToIds, actionsToManifest } from '@/lib/export/classroom-zip-utils';
import {
  CLASSROOM_ZIP_FORMAT_VERSION,
  type ClassroomManifest,
} from '@/lib/export/classroom-zip-types';
import type { SpeechAction, SpotlightAction } from '@/lib/types/action';

// ─── rewriteAudioRefsToIds ────────────────────────────────────

describe('rewriteAudioRefsToIds', () => {
  test('replaces audioRef with new audioId in speech actions', () => {
    const actions = [
      { id: 'a1', type: 'speech' as const, text: 'Hello', audioRef: 'audio/abc.mp3' },
      { id: 'a2', type: 'spotlight' as const, elementId: 'el1' },
    ];
    const audioRefMap = { 'audio/abc.mp3': 'new-audio-id-1' };
    const result = rewriteAudioRefsToIds(actions, audioRefMap);
    expect(result[0]).toMatchObject({
      type: 'speech',
      text: 'Hello',
      audioId: 'new-audio-id-1',
    });
    expect(result[1]).toMatchObject({ type: 'spotlight', elementId: 'el1' });
  });

  test('skips speech actions without audioRef', () => {
    const actions = [
      { id: 'a1', type: 'speech' as const, text: 'Hello', audioUrl: 'https://example.com/a.mp3' },
    ];
    const result = rewriteAudioRefsToIds(actions, {});
    expect(result[0]).toMatchObject({
      type: 'speech',
      text: 'Hello',
      audioUrl: 'https://example.com/a.mp3',
    });
  });
});

// ─── actionsToManifest ────────────────────────────────────────

describe('actionsToManifest', () => {
  test('converts audioId to audioRef for speech actions', () => {
    const actions = [
      {
        id: 'act1',
        type: 'speech' as const,
        text: 'Hello',
        audioId: 'audio-123',
        voice: 'alloy',
        speed: 1,
      } as SpeechAction,
      { id: 'act2', type: 'spotlight' as const, elementId: 'el1' } as SpotlightAction,
    ];
    const audioIdToPath = new Map([['audio-123', 'audio/audio-123.mp3']]);

    const result = actionsToManifest(actions, audioIdToPath);

    expect(result[0]).toMatchObject({
      type: 'speech',
      text: 'Hello',
      audioRef: 'audio/audio-123.mp3',
      voice: 'alloy',
    });
    expect(result[0]).not.toHaveProperty('audioId');
    expect(result[1]).toMatchObject({ type: 'spotlight', elementId: 'el1' });
  });

  test('preserves audioUrl when audioId is absent', () => {
    const actions = [
      {
        id: 'act1',
        type: 'speech' as const,
        text: 'Hi',
        audioUrl: 'https://cdn.example.com/hi.mp3',
      } as SpeechAction,
    ];
    const result = actionsToManifest(actions, new Map());
    expect(result[0]).toMatchObject({
      type: 'speech',
      text: 'Hi',
      audioUrl: 'https://cdn.example.com/hi.mp3',
    });
    expect(result[0]).not.toHaveProperty('audioRef');
  });
});

// ─── Manifest round-trip ──────────────────────────────────────

describe('manifest round-trip', () => {
  test('manifest structure is valid JSON-serializable', () => {
    const manifest: ClassroomManifest = {
      formatVersion: CLASSROOM_ZIP_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      appVersion: '0.1.0',
      stage: {
        name: 'Test Course',
        description: 'A test',
        language: 'en-US',
        style: 'professional',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      agents: [
        {
          name: 'Prof',
          role: 'lecturer',
          persona: 'Friendly professor',
          avatar: '👨‍🏫',
          color: '#4A90D9',
          priority: 1,
        },
      ],
      scenes: [
        {
          type: 'slide',
          title: 'Intro',
          order: 0,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          content: { type: 'slide', canvas: { id: 's1', elements: [] } } as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          actions: [{ id: 'a1', type: 'speech', text: 'Welcome', audioRef: 'audio/a1.mp3' } as any],
        },
      ],
      mediaIndex: {
        'audio/a1.mp3': { type: 'audio', format: 'mp3', duration: 5.2 },
      },
    };

    const serialized = JSON.stringify(manifest);
    const deserialized = JSON.parse(serialized) as ClassroomManifest;

    expect(deserialized.formatVersion).toBe(CLASSROOM_ZIP_FORMAT_VERSION);
    expect(deserialized.stage.name).toBe('Test Course');
    expect(deserialized.agents).toHaveLength(1);
    expect(deserialized.scenes).toHaveLength(1);
    expect(deserialized.scenes[0].actions?.[0]).toMatchObject({
      type: 'speech',
      audioRef: 'audio/a1.mp3',
    });
    expect(deserialized.mediaIndex['audio/a1.mp3']).toMatchObject({
      type: 'audio',
      duration: 5.2,
    });
  });
});
