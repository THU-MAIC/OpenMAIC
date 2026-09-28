/**
 * A realistic browser as the last browser-only build left it: courses in both
 * legacy course stores, their media in all three byte stores, chat in the old
 * table and in the runtime store, a playback row, a roster from before it
 * lived on the stage, folders, pre-runtime quiz keys, device-only rows.
 */
import { LegacyBrowserDatabase, type SceneRecord } from '@/lib/legacy-browser-storage/schema';

import {
  ISO,
  LEGACY_LEARNER,
  NOW,
  course,
  seedAssetPool,
  seedDocumentsStore,
  seedLegacyLearnerKey,
  seedRuntimeStore,
} from './harness';

export const DOCS_COURSE = 'course-docs';
export const TABLES_COURSE = 'course-tables';
export const NARRATION_KEY = 'tts_s1_action_abcdefgh12';
export const TABLE_NARRATION_KEY = 'tts_s0_action_zyxwvuts98';

export const POOL_IMAGE = new Blob(['pool-image-bytes'], { type: 'image/png' });
export const GEN_IMAGE = new Blob(['generated-image-bytes'], { type: 'image/jpeg' });
export const NARRATION = new Blob(['narration-bytes'], { type: 'audio/mpeg' });
export const TABLE_NARRATION = new Blob(['table-narration'], { type: 'audio/mpeg' });
export const VOICE_CLIP = new Blob(['voice-clip'], { type: 'audio/wav' });

export interface SeededBrowser {
  poolImageId: string;
}

/** Seed everything at the latest schema. */
export async function seedLatestBrowser(storage: Storage): Promise<SeededBrowser> {
  const [poolImageId] = await seedAssetPool([POOL_IMAGE]);

  // A course the browser document store holds: a pool image, a generation
  // placeholder whose bytes are in `mediaFiles`, and a derived narration key
  // whose bytes are in `audioFiles`.
  await seedDocumentsStore([
    course(
      DOCS_COURSE,
      [
        { id: 'docs-scene-1', order: 0, imageRef: poolImageId },
        {
          id: 'docs-scene-2',
          order: 1,
          imageRef: 'gen_img_1',
          audioIds: [{ id: 'action_abcdefgh12', audioId: NARRATION_KEY, text: 'Hello there' }],
        },
        { id: 'docs-scene-3', order: 2, imageRef: 'gen_img_2' },
      ],
      'Documents course',
    ),
  ]);

  const legacy = new LegacyBrowserDatabase();
  // A course from before the document store, in the original tables.
  const tablesDocument = course(
    TABLES_COURSE,
    [
      {
        id: 'tables-scene-1',
        order: 0,
        audioIds: [{ id: 'action_zyxwvuts98', audioId: TABLE_NARRATION_KEY, text: 'Welcome' }],
      },
      { id: 'tables-quiz', order: 1 },
    ],
    'Tables course',
  );
  await legacy.stages.put({
    id: TABLES_COURSE,
    name: 'Tables course',
    createdAt: NOW,
    updatedAt: NOW,
    currentSceneId: 'tables-quiz',
  });
  for (const scene of tablesDocument.scenes) {
    await legacy.scenes.put(scene as unknown as SceneRecord);
  }
  await legacy.stageOutlines.put({
    stageId: TABLES_COURSE,
    outlines: [],
    generationComplete: true,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await legacy.generatedAgents.bulkPut([
    {
      id: 'gen-teacher',
      stageId: TABLES_COURSE,
      name: 'Ada',
      role: 'teacher',
      persona: 'Patient',
      avatar: 'a.png',
      color: '#111111',
      priority: 10,
      voiceDesign: { identity: 'warm', delivery: 'slow' } as never,
      createdAt: NOW,
    },
    {
      id: 'gen-student',
      stageId: TABLES_COURSE,
      name: 'Bo',
      role: 'student',
      persona: 'Curious',
      avatar: 'b.png',
      color: '#222222',
      priority: 1,
      createdAt: NOW,
    },
  ]);
  await legacy.chatSessions.put({
    id: 'chat-1',
    stageId: TABLES_COURSE,
    type: 'qa',
    title: 'Question',
    status: 'completed',
    messages: [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Why?' }] },
      { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'Because.' }] },
    ] as never,
    config: { agentIds: ['gen-teacher'], maxTurns: 4, currentTurn: 1 } as never,
    toolCalls: [],
    pendingToolCalls: [],
    createdAt: NOW,
    updatedAt: NOW + 1,
  });
  await legacy.playbackState.put({
    stageId: TABLES_COURSE,
    sceneIndex: 1,
    actionIndex: 0,
    consumedDiscussions: [],
    updatedAt: NOW,
  });
  await legacy.folders.put({
    id: 'legacy-folder',
    name: 'Physics',
    order: 0,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await legacy.folders.put({
    id: 'empty-folder',
    name: 'Empty',
    order: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await legacy.stageFolders.put({
    stageId: TABLES_COURSE,
    folderId: 'legacy-folder',
    updatedAt: NOW,
  });

  // Bytes: the placeholder's generated image, a refused element's failure
  // record, and both courses' narration.
  await legacy.mediaFiles.bulkPut([
    {
      id: `${DOCS_COURSE}:gen_img_1`,
      stageId: DOCS_COURSE,
      type: 'image',
      blob: GEN_IMAGE,
      mimeType: 'image/jpeg',
      size: GEN_IMAGE.size,
      prompt: 'a cat',
      params: '{}',
      createdAt: NOW,
    },
    {
      id: `${DOCS_COURSE}:gen_img_2`,
      stageId: DOCS_COURSE,
      type: 'image',
      blob: new Blob([]),
      mimeType: 'image/png',
      size: 0,
      prompt: 'refused',
      params: '{}',
      error: 'The provider refused this prompt',
      errorCode: 'CONTENT_SENSITIVE',
      createdAt: NOW,
    },
  ]);
  await legacy.audioFiles.bulkPut([
    {
      id: NARRATION_KEY,
      stageId: DOCS_COURSE,
      blob: NARRATION,
      format: 'mp3',
      duration: 1.5,
      text: 'Hello there',
      createdAt: NOW,
    },
    // A row from before the course column: adopted because its action id is
    // a generated one (see narration adoption's ownership rule).
    { id: TABLE_NARRATION_KEY, blob: TABLE_NARRATION, format: 'mp3', createdAt: NOW },
  ]);
  await legacy.autoVoiceCache.put({
    voiceId: 'auto-voice-1',
    referenceAudio: VOICE_CLIP,
    mimeType: 'audio/wav',
    updatedAt: NOW,
  });
  legacy.close();

  // Learner runtime of the documents course, under the old device key.
  seedLegacyLearnerKey(storage);
  await seedRuntimeStore([
    {
      init: {
        id: `whiteboard:${DOCS_COURSE}:${encodeURIComponent(LEGACY_LEARNER)}`,
        kind: 'whiteboard',
        stageId: DOCS_COURSE,
        learnerKey: LEGACY_LEARNER,
        status: 'active',
        createdAt: ISO,
        updatedAt: ISO,
      },
      records: [],
    },
    {
      init: {
        id: `quiz-attempt:${DOCS_COURSE}:docs-scene-3:${encodeURIComponent(LEGACY_LEARNER)}`,
        kind: 'quizAttempt',
        stageId: DOCS_COURSE,
        learnerKey: LEGACY_LEARNER,
        status: 'active',
        createdAt: ISO,
        updatedAt: ISO,
      },
      records: [
        {
          id: 'quiz-record-1',
          sceneId: 'docs-scene-3',
          createdAt: ISO,
          payload: { payloadVersion: 1, phase: 'draft', answers: { q1: 'A' } },
        },
        {
          id: 'quiz-record-2',
          sceneId: 'docs-scene-3',
          createdAt: ISO,
          payload: { payloadVersion: 1, phase: 'submitted', answers: { q1: 'B' } },
        },
      ],
      status: 'completed',
    },
  ]);

  // Pre-runtime quiz state of the tables course's quiz scene.
  storage.setItem('quizAnswers:tables-quiz', JSON.stringify({ q1: 'C' }));
  storage.setItem(
    'quizResults:tables-quiz',
    JSON.stringify([{ questionId: 'q1', correct: true, status: 'correct', earned: 1 }]),
  );
  return { poolImageId: poolImageId! };
}
