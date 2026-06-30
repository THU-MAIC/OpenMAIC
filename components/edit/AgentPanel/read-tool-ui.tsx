'use client';

/**
 * Tool-call UI for `read_scene_content`. A read is lightweight, so this renders a
 * minimal `ToolCard` — title + @scene pill + status badge, no expandable body.
 * Without this, a turn that reads the slide showed a blank gap in the thread;
 * now every tool call renders a uniform card.
 */
import { Eye } from 'lucide-react';
import { makeAssistantToolUI } from '@assistant-ui/react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { ToolCard, type ToolStatus } from './tool-card';

interface ReadSceneContentResult {
  details?: { sceneId?: string };
}

function ReadCard({
  running,
  failed,
  sceneId,
}: {
  running: boolean;
  failed: boolean;
  sceneId?: string;
}) {
  const { t } = useI18n();
  const status: ToolStatus = running ? 'running' : failed ? 'failed' : 'done';
  const statusLabel = running
    ? t('edit.readCard.reading')
    : failed
      ? t('edit.readCard.failed')
      : t('edit.readCard.done');

  return (
    <ToolCard
      title={t('edit.readCard.title')}
      icon={Eye}
      sceneId={sceneId}
      status={status}
      statusLabel={statusLabel}
    />
  );
}

export const ReadSceneContentUI = makeAssistantToolUI<{ sceneId?: string }, ReadSceneContentResult>(
  {
    toolName: 'read_scene_content',
    render: ({ args, status, result, isError }) => {
      const running = status.type === 'running' || status.type === 'requires-action';
      // Bias to success: a read that ran is "done". Only an explicit `isError`
      // is a failure — a missing/unpropagated result (which assistant-ui surfaces
      // as an `incomplete` part status) is NOT, otherwise a successful read shows
      // a spurious ✕ both live and after a refresh restores it without a result.
      const failed = !running && !!isError;
      const sceneId = args?.sceneId ?? result?.details?.sceneId;
      return <ReadCard running={running} failed={failed} sceneId={sceneId} />;
    },
  },
);
