'use client';

import { useState, useCallback, useRef } from 'react';
import { nanoid } from 'nanoid';
import { toast } from 'sonner';
import { useI18n } from '@/lib/hooks/use-i18n';
import { db, mediaFileKey } from '@/lib/utils/database';
import type { AudioFileRecord, MediaFileRecord, GeneratedAgentRecord } from '@/lib/utils/database';
import type { ClassroomManifest, ManifestScene } from '@/lib/export/classroom-zip-types';
import { rewriteAudioRefsToIds } from '@/lib/export/classroom-zip-utils';
import { createLogger } from '@/lib/logger';

const log = createLogger('ImportClassroom');

export type ImportPhase =
  | 'idle'
  | 'parsing'
  | 'validating'
  | 'writingMedia'
  | 'writingCourse'
  | 'done';

export function useImportClassroom(onSuccess?: () => void) {
  const [importing, setImporting] = useState(false);
  const [phase, setPhase] = useState<ImportPhase>('idle');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { t } = useI18n();

  const triggerFileSelect = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      // Reset input so same file can be re-selected
      e.target.value = '';

      setImporting(true);
      setPhase('parsing');
      const toastId = toast.loading(t('import.parsing'));

      try {
        // 0. Size check — warn for files over 200MB
        const MAX_SAFE_SIZE = 200 * 1024 * 1024;
        if (file.size > MAX_SAFE_SIZE) {
          log.warn(`Large ZIP file: ${(file.size / 1024 / 1024).toFixed(0)}MB`);
        }

        // 1. Parse ZIP
        const JSZip = (await import('jszip')).default;
        const zip = await JSZip.loadAsync(file);

        const manifestFile = zip.file('manifest.json');
        if (!manifestFile) {
          toast.error(t('import.error.invalidManifest'), { id: toastId });
          return;
        }

        // 2. Validate
        setPhase('validating');
        toast.loading(t('import.validating'), { id: toastId });

        const manifestText = await manifestFile.async('text');
        let manifest: ClassroomManifest;
        try {
          manifest = JSON.parse(manifestText);
        } catch {
          toast.error(t('import.error.invalidManifest'), { id: toastId });
          return;
        }

        if (!manifest.stage || !manifest.scenes || !Array.isArray(manifest.scenes)) {
          toast.error(t('import.error.missingData'), { id: toastId });
          return;
        }

        // 3. Generate new IDs
        const newStageId = nanoid();
        const now = Date.now();

        // Agent ID mapping: index → new ID
        const newAgentIds: string[] = (manifest.agents ?? []).map(() => nanoid());

        // Audio ref → new ID mapping
        const audioRefToNewId: Record<string, string> = {};
        for (const [zipPath, entry] of Object.entries(manifest.mediaIndex ?? {})) {
          if (entry.type === 'audio' && !entry.missing) {
            audioRefToNewId[zipPath] = nanoid();
          }
        }

        // Media ref → new ID mapping
        const mediaRefToNewId: Record<string, string> = {};
        for (const [zipPath, entry] of Object.entries(manifest.mediaIndex ?? {})) {
          if ((entry.type === 'generated' || entry.type === 'image') && !entry.missing) {
            const filename = zipPath.split('/').pop() ?? '';
            const elementId = filename.replace(/\.\w+$/, '');
            mediaRefToNewId[zipPath] = mediaFileKey(newStageId, elementId);
          }
        }

        // 4. Write media to IndexedDB
        setPhase('writingMedia');
        toast.loading(t('import.writingMedia'), { id: toastId });

        // Write audio files one at a time
        for (const [zipPath, newId] of Object.entries(audioRefToNewId)) {
          const zipEntry = zip.file(zipPath);
          if (!zipEntry) continue;
          const blob = await zipEntry.async('blob');
          const meta = manifest.mediaIndex[zipPath];
          const record: AudioFileRecord = {
            id: newId,
            blob,
            format: meta.format || 'mp3',
            duration: meta.duration,
            voice: meta.voice,
            createdAt: now,
          };
          await db.audioFiles.put(record);
        }

        // Write generated media files one at a time
        for (const [zipPath, newId] of Object.entries(mediaRefToNewId)) {
          const zipEntry = zip.file(zipPath);
          if (!zipEntry) continue;
          const blob = await zipEntry.async('blob');
          const meta = manifest.mediaIndex[zipPath];

          const record: MediaFileRecord = {
            id: newId,
            stageId: newStageId,
            type: meta.mimeType?.startsWith('video/') ? 'video' : 'image',
            blob,
            mimeType: meta.mimeType || 'image/jpeg',
            size: meta.size || blob.size,
            prompt: meta.prompt || '',
            params: '',
            createdAt: now,
          };

          // Check for poster before writing to avoid redundant put
          const posterPath = zipPath.replace(/\.\w+$/, '.poster.jpg');
          const posterEntry = zip.file(posterPath);
          if (posterEntry) {
            record.poster = await posterEntry.async('blob');
          }

          await db.mediaFiles.put(record);
        }

        // 5. Write course data
        setPhase('writingCourse');
        toast.loading(t('import.writingCourse'), { id: toastId });

        // Write stage
        await db.stages.put({
          id: newStageId,
          name: manifest.stage.name || 'Imported Classroom',
          description: manifest.stage.description,
          languageDirective: manifest.stage.language,
          style: manifest.stage.style,
          createdAt: manifest.stage.createdAt || now,
          updatedAt: now,
          agentIds: newAgentIds.length > 0 ? newAgentIds : undefined,
        });

        // Write agents
        if (manifest.agents?.length) {
          const agentRecords: GeneratedAgentRecord[] = manifest.agents.map((a, i) => ({
            id: newAgentIds[i],
            stageId: newStageId,
            name: a.name,
            role: a.role,
            persona: a.persona,
            avatar: a.avatar,
            color: a.color,
            priority: a.priority,
            createdAt: now,
          }));
          await db.generatedAgents.bulkPut(agentRecords);
        }

        // Write scenes with rewritten references
        const sceneRecords = manifest.scenes.map((mScene: ManifestScene, index: number) => {
          const newSceneId = nanoid();

          const actions = mScene.actions
            ? rewriteAudioRefsToIds(mScene.actions, audioRefToNewId)
            : undefined;

          let multiAgent = undefined;
          if (mScene.multiAgent?.enabled) {
            multiAgent = {
              enabled: true,
              agentIds: (mScene.multiAgent.agentIndices ?? [])
                .map((idx) => newAgentIds[idx])
                .filter(Boolean),
              directorPrompt: mScene.multiAgent.directorPrompt,
            };
          }

          return {
            id: newSceneId,
            stageId: newStageId,
            type: mScene.type,
            title: mScene.title,
            order: mScene.order ?? index,
            content: mScene.content,
            actions,
            whiteboard: mScene.whiteboards,
            multiAgent,
            createdAt: now,
            updatedAt: now,
          };
        });
        await db.scenes.bulkPut(sceneRecords);

        // 6. Done
        setPhase('done');
        toast.success(t('import.success'), { id: toastId });
        onSuccess?.();
      } catch (error) {
        log.error('Classroom ZIP import failed:', error);
        const isQuotaError = error instanceof DOMException && error.name === 'QuotaExceededError';
        toast.error(isQuotaError ? t('import.error.storageFull') : t('import.error.invalidZip'), {
          id: toastId,
        });
      } finally {
        setImporting(false);
        setPhase('idle');
      }
    },
    [t, onSuccess],
  );

  return {
    importing,
    phase,
    fileInputRef,
    triggerFileSelect,
    handleFileChange,
  };
}
