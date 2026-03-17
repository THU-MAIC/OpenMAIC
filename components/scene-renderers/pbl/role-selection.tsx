'use client';

import type { PBLAgent, PBLProjectInfo } from '@/lib/pbl/types';
import { useI18n } from '@/lib/hooks/use-i18n';
import { PBLGuideInline } from './guide';

interface PBLRoleSelectionProps {
  readonly projectInfo: PBLProjectInfo;
  readonly agents: PBLAgent[];
  readonly onSelectRole: (agentName: string) => void;
}

export function PBLRoleSelection({ projectInfo, agents, onSelectRole }: PBLRoleSelectionProps) {
  const { t } = useI18n();

  // Only show non-system development roles
  const selectableAgents = agents.filter(
    (a) => !a.is_system_agent && a.role_division === 'development',
  );

  return (
    <div className="flex flex-col items-center h-full overflow-y-auto p-8 bg-gradient-to-b from-background to-muted/30">
      <div className="max-w-2xl w-full space-y-8 my-auto">
        {/* Project Info */}
        <div className="text-center space-y-3">
          <h1 className="text-3xl font-bold tracking-tight">{projectInfo.title}</h1>
          <p className="text-muted-foreground text-lg">{projectInfo.description}</p>
        </div>

        {/* Role Selection */}
        <div className="space-y-4">
          <h2 className="text-xl font-semibold text-center">{t('pbl.roleSelection.title')}</h2>
          <p className="text-sm text-muted-foreground text-center">
            {t('pbl.roleSelection.description')}
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {selectableAgents.map((agent) => (
              <button
                key={agent.name}
                onClick={() => onSelectRole(agent.name)}
                className="group relative flex flex-col items-start gap-2 rounded-xl border-2 border-muted bg-card p-5 text-left transition-all hover:border-primary hover:shadow-md"
              >
                <div className="flex items-center gap-2">
                  <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-sm">
                    {agent.name.charAt(0).toUpperCase()}
                  </div>
                  <h3 className="font-semibold text-base">{agent.name}</h3>
                </div>
                {agent.actor_role && (
                  <p className="text-sm text-muted-foreground line-clamp-2">{agent.actor_role}</p>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* How it works guide */}
        <PBLGuideInline />
      </div>
    </div>
  );
}
