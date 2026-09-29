/**
 * Schema of the pre-server browser database (`MAIC-Database`).
 *
 * READ-ONLY. Used only by the one-way importer that moves a browser's existing
 * courses to the server (and by the one-time carry-over of browser-local voice
 * profiles into the device cache). Do not add writes: nothing in the app
 * writes, clears or deletes this database any more, so a browser keeps its
 * pre-server data exactly as it was until the importer has read it.
 *
 * The version ladder is kept verbatim. Dexie opens a database at its newest
 * declared version and runs the upgrade steps a browser has not run yet, so
 * dropping or editing a step would fail to open (or silently mis-shape) the
 * data of a browser that last ran an older build. Access goes through
 * `./index.ts`, which never opens a database that does not exist.
 */
import Dexie, { type EntityTable, type Table } from 'dexie';

import type {
  AudioFileRecord,
  AutoVoiceCacheRecord,
  ImageFileRecord,
  MediaFileRecord,
  Snapshot,
  VoiceProfileRecord,
} from '@/lib/device-storage/database';
import type { Action } from '@/lib/types/action';
import type {
  SessionConfig,
  SessionStatus,
  SessionType,
  ToolCallRecord,
  ToolCallRequest,
} from '@/lib/types/chat';
import type { FolderRecord } from '@/lib/types/folder';
import type { SceneOutline } from '@/lib/types/generation';
import type {
  GeneratedAgentConfig,
  SceneContent,
  SceneType,
  VideoManifest,
  Whiteboard,
} from '@/lib/types/stage';
import type { VoiceDesign } from '@/lib/audio/voice-design';
import type { UIMessage } from 'ai';

export type {
  AudioFileRecord,
  AutoVoiceCacheRecord,
  FolderRecord,
  ImageFileRecord,
  MediaFileRecord,
  Snapshot,
  VoiceProfileRecord,
};

/**
 * Stage table - Course basic info
 */
export interface StageRecord {
  id: string; // Primary key
  name: string;
  description?: string;
  createdAt: number; // timestamp
  updatedAt: number; // timestamp
  languageDirective?: string;
  style?: string;
  currentSceneId?: string;
  agentIds?: string[]; // Agent IDs selected at creation time
  videoManifest?: VideoManifest; // Generated video request manifest; non-indexed
  interactiveMode?: boolean; // Interactive Mode flag; non-indexed
  taskEngineMode?: boolean; // Vocational Task Engine flag; non-indexed
  generatedAgentConfigs?: GeneratedAgentConfig[]; // Editor-authored agent roster snapshot
}

/**
 * Stage→folder membership as browser storage kept it: one row per course, and a
 * missing row (or `folderId === undefined`) means unfiled. Folders and
 * membership are server data now; these rows are importer input.
 */
export interface StageFolderMembership {
  stageId: string; // Primary key (FK -> DocumentStore stage id)
  folderId?: string; // FK -> folders.id; undefined = unfiled
  updatedAt: number; // timestamp
}

/**
 * Scene table - Scene/page data
 */
export interface SceneRecord {
  id: string; // Primary key
  stageId: string; // Foreign key -> stages.id
  type: SceneType;
  title: string;
  order: number; // Display order
  content: SceneContent; // Stored as JSON
  actions?: Action[]; // Stored as JSON
  whiteboard?: Whiteboard[]; // Stored as JSON
  createdAt: number;
  updatedAt: number;
}

/**
 * ChatSession table - Chat session data
 */
export interface ChatSessionRecord {
  id: string; // PK (session id)
  stageId: string; // FK -> stages.id
  type: SessionType;
  title: string;
  status: SessionStatus;
  messages: UIMessage[]; // JSON-safe serialized messages
  config: SessionConfig;
  toolCalls: ToolCallRecord[];
  pendingToolCalls: ToolCallRequest[];
  createdAt: number;
  updatedAt: number;
  sceneId?: string;
  lastActionIndex?: number;
}

/** Rows of the retired editor right-rail table, kept in the schema so old databases open. */
export interface LegacyAgentEditSessionRecord {
  id: string;
  stageId: string;
  title: string;
  messages: unknown[];
  createdAt: number;
  updatedAt: number;
}

/**
 * PlaybackState table - Playback state snapshot (at most one per stage)
 */
export interface PlaybackStateRecord {
  stageId: string; // PK
  sceneIndex: number;
  actionIndex: number;
  consumedDiscussions: string[];
  updatedAt: number;
}

/**
 * StageOutlines table - Persisted outlines for resume-on-refresh
 */
export interface StageOutlinesRecord {
  stageId: string; // Primary key (FK -> stages.id)
  outlines: SceneOutline[];
  // True once generation finished for this stage. Gates resume-on-mount so an
  // edited (e.g. slide-deleted) finished deck is not treated as "interrupted"
  // and regenerated. Optional for backward compat with pre-existing records.
  generationComplete?: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * GeneratedAgent table - AI-generated agent profiles, from before the roster
 * moved onto the stage document (`stage.generatedAgentConfigs`).
 */
export interface GeneratedAgentRecord {
  id: string; // PK: agent ID (e.g. "gen-abc123")
  stageId: string; // FK -> stages.id
  name: string;
  role: string; // 'teacher' | 'assistant' | 'student'
  persona: string;
  avatar: string;
  color: string;
  priority: number;
  voiceDesign?: VoiceDesign; // 3-layer vocal descriptor for auto voice
  createdAt: number;
}

// ==================== Database Definition ====================

export const LEGACY_DATABASE_NAME = 'MAIC-Database';

/** The pre-server browser database, as its last schema version declared it. */
export class LegacyBrowserDatabase extends Dexie {
  // Table definitions
  stages!: EntityTable<StageRecord, 'id'>;
  scenes!: EntityTable<SceneRecord, 'id'>;
  audioFiles!: EntityTable<AudioFileRecord, 'id'>;
  imageFiles!: EntityTable<ImageFileRecord, 'id'>;
  snapshots!: EntityTable<Snapshot, 'id'>; // Undo/redo snapshots (legacy)
  chatSessions!: EntityTable<ChatSessionRecord, 'id'>;
  chatRestoreStaging!: Table<ChatSessionRecord, [string, string]>;
  playbackState!: EntityTable<PlaybackStateRecord, 'stageId'>;
  stageOutlines!: EntityTable<StageOutlinesRecord, 'stageId'>;
  mediaFiles!: EntityTable<MediaFileRecord, 'id'>;
  generatedAgents!: EntityTable<GeneratedAgentRecord, 'id'>;
  voiceProfiles!: EntityTable<VoiceProfileRecord, 'id'>;
  autoVoiceCache!: EntityTable<AutoVoiceCacheRecord, 'voiceId'>;
  agentEditSessions!: EntityTable<LegacyAgentEditSessionRecord, 'id'>;
  folders!: EntityTable<FolderRecord, 'id'>;
  stageFolders!: EntityTable<StageFolderMembership, 'stageId'>;

  constructor() {
    super(LEGACY_DATABASE_NAME);

    // Version 1: Initial schema
    this.version(1).stores({
      stages: 'id, updatedAt',
      scenes: 'id, stageId, order, [stageId+order]',
      audioFiles: 'id, createdAt',
      imageFiles: 'id, createdAt',
      snapshots: '++id',
      // Previously had: messages, participants, discussions, sceneSnapshots
    });

    // Version 2: Remove unused tables
    this.version(2).stores({
      stages: 'id, updatedAt',
      scenes: 'id, stageId, order, [stageId+order]',
      audioFiles: 'id, createdAt',
      imageFiles: 'id, createdAt',
      snapshots: '++id',
      // Delete removed tables
      messages: null,
      participants: null,
      discussions: null,
      sceneSnapshots: null,
    });

    // Version 3: Add chatSessions and playbackState tables
    this.version(3).stores({
      stages: 'id, updatedAt',
      scenes: 'id, stageId, order, [stageId+order]',
      audioFiles: 'id, createdAt',
      imageFiles: 'id, createdAt',
      snapshots: '++id',
      chatSessions: 'id, stageId, [stageId+createdAt]',
      playbackState: 'stageId',
    });

    // Version 4: Add stageOutlines table for resume-on-refresh
    this.version(4).stores({
      stages: 'id, updatedAt',
      scenes: 'id, stageId, order, [stageId+order]',
      audioFiles: 'id, createdAt',
      imageFiles: 'id, createdAt',
      snapshots: '++id',
      chatSessions: 'id, stageId, [stageId+createdAt]',
      playbackState: 'stageId',
      stageOutlines: 'stageId',
    });

    // Version 5: Add mediaFiles table for async media generation
    this.version(5).stores({
      stages: 'id, updatedAt',
      scenes: 'id, stageId, order, [stageId+order]',
      audioFiles: 'id, createdAt',
      imageFiles: 'id, createdAt',
      snapshots: '++id',
      chatSessions: 'id, stageId, [stageId+createdAt]',
      playbackState: 'stageId',
      stageOutlines: 'stageId',
      mediaFiles: 'id, stageId, [stageId+type]',
    });

    // Version 6: Fix mediaFiles primary key — use compound key stageId:elementId
    // to prevent cross-course collisions (gen_img_1 is NOT globally unique)
    this.version(6)
      .stores({
        stages: 'id, updatedAt',
        scenes: 'id, stageId, order, [stageId+order]',
        audioFiles: 'id, createdAt',
        imageFiles: 'id, createdAt',
        snapshots: '++id',
        chatSessions: 'id, stageId, [stageId+createdAt]',
        playbackState: 'stageId',
        stageOutlines: 'stageId',
        mediaFiles: 'id, stageId, [stageId+type]',
      })
      .upgrade(async (tx) => {
        const table = tx.table('mediaFiles');
        const allRecords = await table.toArray();
        for (const rec of allRecords) {
          const newKey = `${rec.stageId}:${rec.id}`;
          // Skip if already migrated (idempotent)
          if (rec.id.includes(':')) continue;
          await table.delete(rec.id);
          await table.put({ ...rec, id: newKey });
        }
      });

    // Version 7: Add ossKey fields to mediaFiles and audioFiles for OSS storage plugin
    // Non-indexed optional fields — Dexie handles these transparently.
    this.version(7).stores({
      stages: 'id, updatedAt',
      scenes: 'id, stageId, order, [stageId+order]',
      audioFiles: 'id, createdAt',
      imageFiles: 'id, createdAt',
      snapshots: '++id',
      chatSessions: 'id, stageId, [stageId+createdAt]',
      playbackState: 'stageId',
      stageOutlines: 'stageId',
      mediaFiles: 'id, stageId, [stageId+type]',
    });

    // Version 8: Add generatedAgents table for AI-generated agent profiles
    this.version(8).stores({
      stages: 'id, updatedAt',
      scenes: 'id, stageId, order, [stageId+order]',
      audioFiles: 'id, createdAt',
      imageFiles: 'id, createdAt',
      snapshots: '++id',
      chatSessions: 'id, stageId, [stageId+createdAt]',
      playbackState: 'stageId',
      stageOutlines: 'stageId',
      mediaFiles: 'id, stageId, [stageId+type]',
      generatedAgents: 'id, stageId',
    });

    // Version 9: Migrate legacy `language` field to `languageDirective`
    // Old stages stored a BCP-47 locale code (e.g. "zh-CN"); new code expects a
    // natural-language directive. Convert known locales and drop the old field.
    const LOCALE_TO_DIRECTIVE: Record<string, string> = {
      'zh-CN': 'Deliver the entire course in Chinese (Simplified, zh-CN).',
      'en-US': 'Deliver the entire course in English (en-US).',
      'ja-JP': 'Deliver the entire course in Japanese (ja-JP).',
      'ru-RU': 'Deliver the entire course in Russian (ru-RU).',
    };
    this.version(9)
      .stores({
        stages: 'id, updatedAt',
        scenes: 'id, stageId, order, [stageId+order]',
        audioFiles: 'id, createdAt',
        imageFiles: 'id, createdAt',
        snapshots: '++id',
        chatSessions: 'id, stageId, [stageId+createdAt]',
        playbackState: 'stageId',
        stageOutlines: 'stageId',
        mediaFiles: 'id, stageId, [stageId+type]',
        generatedAgents: 'id, stageId',
      })
      .upgrade(async (tx) => {
        const table = tx.table('stages');
        await table.toCollection().modify((stage: Record<string, unknown>) => {
          const lang = stage.language as string | undefined;
          if (lang && !stage.languageDirective) {
            stage.languageDirective =
              LOCALE_TO_DIRECTIVE[lang] || `Deliver the entire course in ${lang}.`;
          }
          delete stage.language;
        });
      });

    // Version 10: Add browser-local voice profiles for serverless TTS voice storage.
    this.version(10).stores({
      stages: 'id, updatedAt',
      scenes: 'id, stageId, order, [stageId+order]',
      audioFiles: 'id, createdAt',
      imageFiles: 'id, createdAt',
      snapshots: '++id',
      chatSessions: 'id, stageId, [stageId+createdAt]',
      playbackState: 'stageId',
      stageOutlines: 'stageId',
      mediaFiles: 'id, stageId, [stageId+type]',
      generatedAgents: 'id, stageId',
      voiceProfiles: 'id, providerId, kind, updatedAt',
    });

    // Version 11: Add auto-voice reference-clip cache (provider-neutral register-by-id).
    this.version(11).stores({
      stages: 'id, updatedAt',
      scenes: 'id, stageId, order, [stageId+order]',
      audioFiles: 'id, createdAt',
      imageFiles: 'id, createdAt',
      snapshots: '++id',
      chatSessions: 'id, stageId, [stageId+createdAt]',
      playbackState: 'stageId',
      stageOutlines: 'stageId',
      mediaFiles: 'id, stageId, [stageId+type]',
      generatedAgents: 'id, stageId',
      voiceProfiles: 'id, providerId, kind, updatedAt',
      autoVoiceCache: 'voiceId, updatedAt',
    });

    // Version 12: Add agentEditSessions — multi-session AI-editing conversation
    // history per stage (replaces the single-thread localStorage store).
    this.version(12).stores({
      stages: 'id, updatedAt',
      scenes: 'id, stageId, order, [stageId+order]',
      audioFiles: 'id, createdAt',
      imageFiles: 'id, createdAt',
      snapshots: '++id',
      chatSessions: 'id, stageId, [stageId+createdAt]',
      playbackState: 'stageId',
      stageOutlines: 'stageId',
      mediaFiles: 'id, stageId, [stageId+type]',
      generatedAgents: 'id, stageId',
      voiceProfiles: 'id, providerId, kind, updatedAt',
      autoVoiceCache: 'voiceId, updatedAt',
      agentEditSessions: 'id, stageId, [stageId+updatedAt]',
    });

    // Version 13 briefly added chatStorageLocks on the draft chat cutover
    // branch. Advance past it and remove the abandoned lease table so database
    // versions stay monotonic for anyone who opened that intermediate build.
    this.version(14).stores({
      stages: 'id, updatedAt',
      scenes: 'id, stageId, order, [stageId+order]',
      audioFiles: 'id, createdAt',
      imageFiles: 'id, createdAt',
      snapshots: '++id',
      chatSessions: 'id, stageId, [stageId+createdAt]',
      playbackState: 'stageId',
      stageOutlines: 'stageId',
      mediaFiles: 'id, stageId, [stageId+type]',
      generatedAgents: 'id, stageId',
      voiceProfiles: 'id, providerId, kind, updatedAt',
      autoVoiceCache: 'voiceId, updatedAt',
      agentEditSessions: 'id, stageId, [stageId+updatedAt]',
      chatStorageLocks: null,
    });

    // Version 15: backup restore staging must preserve chat IDs that are reused
    // in different stage partitions; the legacy chat table is keyed by id only.
    this.version(15).stores({
      chatRestoreStaging: '[stageId+id], stageId, [stageId+createdAt]',
    });

    // Version 16: make newly-written audio independently reclaimable by stage.
    // Legacy rows remain valid and are found through speech-action references.
    this.version(16).stores({
      audioFiles: 'id, stageId, createdAt',
    });

    // Version 17: Course folders — group courses into user-created folders.
    // `folders` holds folder metadata; `stageFolders` maps each course (by
    // DocumentStore stage id) to its folder. Neither touches the document
    // aggregate: folder grouping is device-local organization metadata kept in
    // this Dexie database alongside the legacy tables, so an existing course
    // with no membership row is simply unfiled (no upgrade callback needed).
    this.version(17).stores({
      folders: 'id, order',
      stageFolders: 'stageId, folderId',
    });
  }
}
