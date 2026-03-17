'use client';

import { useCallback } from 'react';
import type { PBLContent } from '@/lib/types/stage';
import type { PBLProjectConfig } from '@/lib/pbl/types';
import { useStageStore } from '@/lib/store/stage';
import { PBLRoleSelection } from './pbl/role-selection';
import { PBLWorkspace } from './pbl/workspace';
import { useI18n } from '@/lib/hooks/use-i18n';

interface PBLRendererProps {
  readonly content: PBLContent;
  readonly mode: 'autonomous' | 'playback';
  readonly sceneId: string;
}

export function PBLRenderer({ content, mode: _mode, sceneId }: PBLRendererProps) {
  const { t } = useI18n();

  const { projectConfig } = content;
  const selectedRole = projectConfig?.selectedRole ?? null;

  const updateConfig = useCallback(
    (updatedConfig: PBLProjectConfig) => {
      const scenes = useStageStore.getState().scenes;
      const updatedScenes = scenes.map((scene) =>
        scene.id === sceneId
          ? {
              ...scene,
              content: { type: 'pbl' as const, projectConfig: updatedConfig },
            }
          : scene,
      );
      useStageStore.setState({ scenes: updatedScenes });
    },
    [sceneId],
  );

  const handleSelectRole = useCallback(
    (roleName: string) => {
      if (!projectConfig) return;
      const newConfig = { ...projectConfig, selectedRole: roleName };

      // Add Question Agent welcome message if chat is empty and active issue has questions
      const activeIssue = newConfig.issueboard.issues.find((i) => i.is_active);
      if (activeIssue?.generated_questions && newConfig.chat.messages.length === 0) {
        const welcomeMsg = t('pbl.chat.welcomeMessage')
          .replace('{title}', activeIssue.title)
          .replace('{questions}', activeIssue.generated_questions);
        newConfig.chat = {
          messages: [
            {
              id: `msg_welcome_${Date.now()}`,
              agent_name: activeIssue.question_agent_name,
              message: welcomeMsg,
              timestamp: Date.now(),
              read_by: [],
            },
          ],
        };
      }

      updateConfig(newConfig);
    },
    [projectConfig, updateConfig, t],
  );

  const handleReset = useCallback(() => {
    if (!projectConfig) return;
    // Reset all issues and re-activate the first one
    const resetIssues = projectConfig.issueboard.issues
      .map((i) => ({ ...i, is_done: false, is_active: false }))
      .sort((a, b) => a.index - b.index);
    if (resetIssues.length > 0) {
      resetIssues[0].is_active = true;
    }

    updateConfig({
      ...projectConfig,
      selectedRole: null,
      chat: { messages: [] },
      issueboard: {
        ...projectConfig.issueboard,
        issues: resetIssues,
        current_issue_id: resetIssues.length > 0 ? resetIssues[0].id : null,
      },
    });
  }, [projectConfig, updateConfig]);

  // Check for legacy format (old PBL with url/html)
  if (!projectConfig) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <p>{t('pbl.legacyFormat')}</p>
      </div>
    );
  }

  // Check if project has been generated (has agents)
  if (projectConfig.agents.length === 0 && projectConfig.projectInfo.title === '') {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <p>{t('pbl.emptyProject')}</p>
      </div>
    );
  }

  // No role selected → show role selection
  if (!selectedRole) {
    return (
      <PBLRoleSelection
        projectInfo={projectConfig.projectInfo}
        agents={projectConfig.agents}
        onSelectRole={handleSelectRole}
      />
    );
  }

  // Role selected → show workspace
  return (
    <PBLWorkspace
      projectConfig={projectConfig}
      userRole={selectedRole}
      onConfigUpdate={updateConfig}
      onReset={handleReset}
    />
  );
}
