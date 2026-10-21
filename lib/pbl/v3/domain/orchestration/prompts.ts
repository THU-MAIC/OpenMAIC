import type { AgentRole } from '../project/project-schema';

export interface AgentPromptDefinition {
  systemPrompt: string;
}

export interface PromptProjectDefinition {
  commonRules?: string;
  agents: Partial<Record<AgentRole, AgentPromptDefinition>>;
}

export interface BuildSystemPromptInput {
  role: AgentRole;
  seed: Readonly<Record<string, unknown>>;
  project: PromptProjectDefinition;
  mentorNote?: string;
}

export function buildSystemPrompt({
  role,
  seed,
  project,
  mentorNote,
}: BuildSystemPromptInput): string {
  const template = project.agents[role]?.systemPrompt ?? `你是 ${role}。`;
  const context = JSON.stringify(seed);
  const rendered = template.includes('{{seed}}')
    ? template.replace('{{seed}}', () => context)
    : `${template}\n\n${context}`;
  const commonRules = project.commonRules ?? '';
  const note = mentorNote ? `\n\n[导师提示] ${mentorNote}` : '';
  return `${rendered}${commonRules}${note}`;
}
