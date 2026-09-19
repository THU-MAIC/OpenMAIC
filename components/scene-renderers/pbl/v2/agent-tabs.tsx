'use client';

/**
 * PBL v2 — Agent tabs.
 *
 * A container that hosts one or more agent chat threads. The tabs UI is
 * only rendered when there is more than one agent — single-agent
 * projects (the norm today, with just the Instructor) skip the header
 * bar entirely so the workspace doesn't look chatty before it needs to.
 *
 * The component is intentionally minimal: it just routes to `PBLV2Chat`
 * for the active agent. If additional roles are introduced later, each
 * tab will mount its own chat component bound to that agent's thread.
 */

import { useMemo, useState } from 'react';
import { GraduationCap, LifeBuoy, SearchCheck, Users } from 'lucide-react';
import type { PBLProjectV2, PBLRoleType } from '@/lib/pbl/v2/types';
import { cn } from '@/lib/utils/cn';
import { PBLV2Chat } from './chat';
import { ScenarioStage } from './scene-stage/scenario-stage';
import type { SubmissionEvaluationStatus } from './submission';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { StreamDisplayState } from './use-instructor-stream';

interface Props {
  readonly project: PBLProjectV2;
  readonly onProjectChange: (next: PBLProjectV2) => void;
  readonly submissionEvaluationStatus?: SubmissionEvaluationStatus | null;
  readonly instructorStreaming: boolean;
  readonly onInstructorStreamingChange: (active: boolean) => void;
  readonly externalStream?: StreamDisplayState | null;
}

export function PBLV2AgentTabs({
  project,
  onProjectChange,
  submissionEvaluationStatus,
  instructorStreaming,
  onInstructorStreamingChange,
  externalStream,
}: Props) {
  const { t } = useI18n();
  // Stage A only has Instructor; future agents push more entries here.
  const agents = useMemo(() => project.roles.filter((r) => r.type !== 'user'), [project.roles]);

  const [activeAgentId, setActiveAgentId] = useState<string | undefined>(agents[0]?.id);

  const activeAgent = agents.find((a) => a.id === activeAgentId) ?? agents[0];

  if (agents.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground p-4">
        {t('pbl.v2.agentTabs.noAgent')}
      </div>
    );
  }

  const showTabsBar = agents.length > 1;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {showTabsBar && (
        <div className="border-b flex items-center gap-1 px-2 py-1.5 bg-muted/30">
          {agents.map((agent) => (
            <button
              key={agent.id}
              onClick={() => setActiveAgentId(agent.id)}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                agent.id === activeAgent?.id
                  ? 'bg-card border border-border shadow-sm'
                  : 'text-muted-foreground hover:bg-card/50',
              )}
            >
              <RoleIcon roleType={agent.type} />
              {agent.name}
            </button>
          ))}
        </div>
      )}
      {/* SCENARIO ONLY (increment 5): entrance animation + persistent scene
          banner at the top of the chat column. Self-gates to null for
          ordinary projects and outside roleplay stages — zero footprint. */}
      <ScenarioStage project={project} />
      <PBLV2Chat
        project={project}
        onProjectChange={onProjectChange}
        agentName={activeAgent?.name}
        submissionEvaluationStatus={submissionEvaluationStatus}
        instructorStreaming={instructorStreaming}
        onInstructorStreamingChange={onInstructorStreamingChange}
        externalStream={externalStream}
      />
    </div>
  );
}

function RoleIcon({ roleType }: { readonly roleType: PBLRoleType }) {
  if (roleType === 'instructor') {
    return <GraduationCap className="w-3.5 h-3.5" />;
  }
  if (roleType === 'evaluator') {
    return <SearchCheck className="w-3.5 h-3.5" />;
  }
  if (roleType === 'mentor') {
    return <LifeBuoy className="w-3.5 h-3.5" />;
  }
  if (roleType === 'collaborator') {
    return <Users className="w-3.5 h-3.5" />;
  }
  return null;
}
