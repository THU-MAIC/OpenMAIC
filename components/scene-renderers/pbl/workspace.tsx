'use client';

import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import type { PBLProjectConfig } from '@/lib/pbl/types';
import { IssueboardPanel } from './issueboard-panel';
import { ChatPanel } from './chat-panel';
import { usePBLChat } from './use-pbl-chat';
import { PBLGuidePanel } from './guide';
import { useI18n } from '@/lib/hooks/use-i18n';

interface PBLWorkspaceProps {
  readonly projectConfig: PBLProjectConfig;
  readonly userRole: string;
  readonly onConfigUpdate: (config: PBLProjectConfig) => void;
  readonly onReset: () => void;
}

export function PBLWorkspace({
  projectConfig,
  userRole,
  onConfigUpdate,
  onReset,
}: PBLWorkspaceProps) {
  const { t } = useI18n();
  const [showConfirm, setShowConfirm] = useState(false);

  const { messages, isLoading, sendMessage, currentIssue } = usePBLChat({
    projectConfig,
    userRole,
    onConfigUpdate,
  });

  return (
    <div className="flex h-full w-full">
      {/* Left: Issueboard (~35%) */}
      <div className="w-[35%] min-w-[280px] border-r overflow-hidden flex flex-col">
        {/* Back button bar */}
        <div className="px-3 pt-2 flex items-center gap-1.5">
          {!showConfirm ? (
            <div className="flex items-center gap-1 flex-1">
              <button
                onClick={() => setShowConfirm(true)}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors px-1.5 py-1 rounded-md hover:bg-muted"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>{t('pbl.workspace.restart')}</span>
              </button>
              <div className="ml-auto">
                <PBLGuidePanel />
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-muted-foreground">{t('pbl.workspace.confirmRestart')}</span>
              <button
                onClick={() => {
                  setShowConfirm(false);
                  onReset();
                }}
                className="px-2 py-0.5 rounded bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors"
              >
                {t('pbl.workspace.confirm')}
              </button>
              <button
                onClick={() => setShowConfirm(false)}
                className="px-2 py-0.5 rounded bg-muted hover:bg-muted/80 transition-colors"
              >
                {t('pbl.workspace.cancel')}
              </button>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-hidden">
          <IssueboardPanel issueboard={projectConfig.issueboard} />
        </div>
      </div>

      {/* Right: Chat (~65%) */}
      <div className="flex-1 overflow-hidden">
        <ChatPanel
          messages={messages}
          currentIssue={currentIssue}
          userRole={userRole}
          isLoading={isLoading}
          onSendMessage={sendMessage}
        />
      </div>
    </div>
  );
}
