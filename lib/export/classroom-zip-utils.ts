import type { Action, SpeechAction } from '@/lib/types/action';
import type { ManifestAction } from './classroom-zip-types';
import { db } from '@/lib/utils/database';
import type { AudioFileRecord, MediaFileRecord } from '@/lib/utils/database';
import type { Scene } from '@/lib/types/stage';

// ─── Export: Collect Media ─────────────────────────────────────

export interface CollectedAudio {
  zipPath: string;
  record: AudioFileRecord;
}

export interface CollectedMedia {
  zipPath: string;
  record: MediaFileRecord;
  elementId: string;
}

export async function collectAudioFiles(scenes: Scene[]): Promise<CollectedAudio[]> {
  const audioIds = new Set<string>();
  for (const scene of scenes) {
    for (const action of scene.actions ?? []) {
      if (action.type === 'speech' && (action as SpeechAction).audioId) {
        audioIds.add((action as SpeechAction).audioId!);
      }
    }
  }
  const collected: CollectedAudio[] = [];
  for (const audioId of audioIds) {
    const record = await db.audioFiles.get(audioId);
    if (record) {
      const ext = record.format || 'mp3';
      collected.push({ zipPath: `audio/${audioId}.${ext}`, record });
    }
  }
  return collected;
}

export async function collectMediaFiles(stageId: string): Promise<CollectedMedia[]> {
  const records = await db.mediaFiles.where('stageId').equals(stageId).toArray();
  const collected: CollectedMedia[] = [];
  for (const record of records) {
    const elementId = record.id.includes(':') ? record.id.split(':').slice(1).join(':') : record.id;
    const ext = record.mimeType?.split('/')[1] || 'jpg';
    collected.push({ zipPath: `media/${elementId}.${ext}`, record, elementId });
  }
  return collected;
}

// ─── Export: Action Serialization ──────────────────────────────

export function actionsToManifest(
  actions: Action[],
  audioIdToPath: Map<string, string>,
): ManifestAction[] {
  return actions.map((action) => {
    if (action.type === 'speech') {
      const speech = action as SpeechAction;
      const { audioId, ...rest } = speech;
      const audioRef = audioId ? audioIdToPath.get(audioId) : undefined;
      return {
        ...rest,
        ...(audioRef ? { audioRef } : {}),
        ...(speech.audioUrl ? { audioUrl: speech.audioUrl } : {}),
      } as ManifestAction;
    }
    return action as ManifestAction;
  });
}

// ─── Import: Reference Rewriting ───────────────────────────────

export function rewriteAudioRefsToIds(
  actions: ManifestAction[],
  audioRefMap: Record<string, string>,
): Action[] {
  return actions.map((action) => {
    if (action.type === 'speech' && 'audioRef' in action) {
      const { audioRef, ...rest } = action;
      const audioId = audioRef ? audioRefMap[audioRef] : undefined;
      return {
        ...rest,
        ...(audioId ? { audioId } : {}),
      } as Action;
    }
    return action as Action;
  });
}
