import { describe, test, expect } from 'vitest';
import { rewriteAudioRefsToIds, actionsToManifest } from '@/lib/export/classroom-zip-utils';
import {
  CLASSROOM_ZIP_FORMAT_VERSION,
  agentConfigFromManifest,
  manifestAgentFromConfig,
  type ClassroomManifest,
} from '@/lib/export/classroom-zip-types';
import type { DiscussionAction, SpeechAction, SpotlightAction } from '@/lib/types/action';
import type { GeneratedAgentConfig } from '@/lib/types/stage';

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

  test('replaces discussion agentIndex with imported agentId', () => {
    const actions = [{ id: 'a1', type: 'discussion' as const, topic: 'Discuss', agentIndex: 1 }];
    const result = rewriteAudioRefsToIds(actions, {}, { agentIds: ['agent-1', 'agent-2'] });
    expect(result[0]).toMatchObject({
      type: 'discussion',
      topic: 'Discuss',
      agentId: 'agent-2',
    });
    expect(result[0]).not.toHaveProperty('agentIndex');
  });

  test('falls back to a valid imported agent when legacy discussion agentId is stale', () => {
    const actions = [
      { id: 'a1', type: 'discussion' as const, topic: 'Discuss', agentId: 'old-agent-id' },
    ];
    const result = rewriteAudioRefsToIds(
      actions,
      {},
      {
        agentIds: ['teacher-1', 'student-1'],
        fallbackDiscussionAgentIndex: 1,
      },
    );
    expect(result[0]).toMatchObject({
      type: 'discussion',
      topic: 'Discuss',
      agentId: 'student-1',
    });
  });

  test('preserves legacy discussion agentId when imported classroom has no generated agents', () => {
    const actions = [
      { id: 'a1', type: 'discussion' as const, topic: 'Discuss', agentId: 'default-2' },
    ];
    const result = rewriteAudioRefsToIds(actions, {}, { agentIds: [] });
    expect(result[0]).toMatchObject({
      type: 'discussion',
      topic: 'Discuss',
      agentId: 'default-2',
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

  test('converts discussion agentId to agentIndex', () => {
    const actions = [
      {
        id: 'act1',
        type: 'discussion' as const,
        topic: 'What tradeoff would you make?',
        prompt: 'Argue for one compromise.',
        agentId: 'student-2',
      } as DiscussionAction,
    ];
    const result = actionsToManifest(actions, new Map(), new Map([['student-2', 2]]));
    expect(result[0]).toMatchObject({
      type: 'discussion',
      topic: 'What tradeoff would you make?',
      prompt: 'Argue for one compromise.',
      agentIndex: 2,
    });
    expect(result[0]).not.toHaveProperty('agentId');
  });

  test('preserves discussion agentId when no manifest agent index is available', () => {
    const actions = [
      {
        id: 'act1',
        type: 'discussion' as const,
        topic: 'Which viewpoint is stronger?',
        agentId: 'default-2',
      } as DiscussionAction,
    ];
    const result = actionsToManifest(actions, new Map(), new Map());
    expect(result[0]).toMatchObject({
      type: 'discussion',
      topic: 'Which viewpoint is stronger?',
      agentId: 'default-2',
    });
    expect(result[0]).not.toHaveProperty('agentIndex');
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
        {
          name: 'Student',
          role: 'student',
          persona: 'Reflective student',
          avatar: '🧑‍🎓',
          color: '#FFB347',
          priority: 2,
        },
      ],
      scenes: [
        {
          type: 'slide',
          title: 'Intro',
          order: 0,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          content: { type: 'slide', canvas: { id: 's1', elements: [] } } as any,
          actions: [
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { id: 'a1', type: 'speech', text: 'Welcome', audioRef: 'audio/a1.mp3' } as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { id: 'a2', type: 'discussion', topic: 'Why does this matter?', agentIndex: 1 } as any,
          ],
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
    expect(deserialized.agents).toHaveLength(2);
    expect(deserialized.scenes).toHaveLength(1);
    expect(deserialized.scenes[0].actions?.[0]).toMatchObject({
      type: 'speech',
      audioRef: 'audio/a1.mp3',
    });
    expect(deserialized.scenes[0].actions?.[1]).toMatchObject({
      type: 'discussion',
      topic: 'Why does this matter?',
      agentIndex: 1,
    });
    expect(deserialized.mediaIndex['audio/a1.mp3']).toMatchObject({
      type: 'audio',
      duration: 5.2,
    });
  });

  test('agent voice fields survive an export/import round trip (up to id renaming)', () => {
    const config: GeneratedAgentConfig = {
      id: 'gen-original',
      name: 'Narrator',
      role: 'teacher',
      persona: 'Explains carefully',
      avatar: '/avatars/teacher.png',
      color: '#3b82f6',
      priority: 10,
      voiceConfig: { providerId: 'some-tts', voiceId: 'voice-1' },
      voiceDesign: { identity: 'adult narrator', texture: 'low and clear', delivery: 'measured' },
    };

    const manifestAgent = JSON.parse(JSON.stringify(manifestAgentFromConfig(config)));
    const imported = agentConfigFromManifest(manifestAgent, 'gen-new');

    expect(imported).toEqual({ ...config, id: 'gen-new' });
  });

  test('agents without voice fields round-trip without inventing them', () => {
    const config: GeneratedAgentConfig = {
      id: 'gen-a',
      name: 'Student',
      role: 'student',
      persona: 'Curious',
      avatar: '/avatars/curious.png',
      color: '#ec4899',
      priority: 5,
    };

    const imported = agentConfigFromManifest(manifestAgentFromConfig(config), 'gen-b');

    expect(imported).toEqual({ ...config, id: 'gen-b' });
    expect('voiceConfig' in imported).toBe(false);
    expect('voiceDesign' in imported).toBe(false);
  });

  test('malformed voice fields in a manifest are dropped without losing the agent', () => {
    // Manifests are parsed JSON from user-supplied ZIPs: the typed shape is a
    // claim, not a guarantee. Junk voice structures must not enter the
    // document (and from there the registry/TTS path).
    const junkAgent = {
      name: 'Crafted',
      role: 'teacher',
      persona: 'p',
      avatar: 'a',
      color: '#000',
      priority: 10,
      voiceConfig: { providerId: { nested: true }, voiceId: 0 },
      voiceDesign: { identity: 1, texture: null, delivery: ['x'] },
    } as unknown as Parameters<typeof agentConfigFromManifest>[0];

    const imported = agentConfigFromManifest(junkAgent, 'gen-x');

    expect(imported.name).toBe('Crafted');
    expect('voiceConfig' in imported).toBe(false);
    expect('voiceDesign' in imported).toBe(false);
  });

  test('voice-field validation is per field: a valid design survives an invalid binding', () => {
    const agent = {
      name: 'Half valid',
      role: 'student',
      persona: 'p',
      avatar: 'a',
      color: '#000',
      priority: 5,
      voiceConfig: { providerId: 'tts', voiceId: 42 },
      voiceDesign: { identity: 'adult', texture: 'low', delivery: 'calm' },
    } as unknown as Parameters<typeof agentConfigFromManifest>[0];

    const imported = agentConfigFromManifest(agent, 'gen-y');

    expect('voiceConfig' in imported).toBe(false);
    expect(imported.voiceDesign).toEqual({ identity: 'adult', texture: 'low', delivery: 'calm' });
  });
});
