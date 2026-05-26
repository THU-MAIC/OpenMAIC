/**
 * Build director system prompts for both the "post-fix" (current main) and
 * "pre-fix" (rules 10/11/12 removed) variants, so the eval can A/B them on
 * the same conversation context.
 *
 * Rules 10/11/12 are the prompt-layer guardrails added by #554. The pre-fix
 * variant mimics main^ by dropping them from the # Rules section.
 *
 * We avoid the public `buildDirectorPrompt()` because it always loads the
 * current template. Here we read the template directly, optionally edit it,
 * then run the same processSnippets → interpolateVariables pipeline.
 */

import fs from 'fs';
import path from 'path';
import {
  processSnippets,
  processConditionalBlocks,
  interpolateVariables,
} from '@/lib/prompts/loader';
import type { OpenAIMessage } from '@/lib/orchestration/summarizers/conversation-summary';
import { summarizeConversation } from '@/lib/orchestration/summarizers/conversation-summary';
import type { ScenarioAgent } from './types';
import type { AgentTurnSummary } from '@/lib/orchestration/types';

/** Rule numbers introduced by #554 that the pre-fix variant must strip. */
const FIX_RULE_NUMBERS = [10, 11, 12] as const;

function readDirectorTemplate(): string {
  const p = path.join(process.cwd(), 'lib', 'prompts', 'templates', 'director', 'system.md');
  return fs.readFileSync(p, 'utf-8').trim();
}

/**
 * Strip rules 10/11/12 from the # Rules section. Each rule is a single line
 * in the current template; we match by leading `^(10|11|12)\.\s` and drop
 * the whole line. Throws if any expected rule is missing so a template
 * rewrite forces us to revisit this eval.
 */
export function stripFixRules(template: string): string {
  const lines = template.split('\n');
  const kept: string[] = [];
  const dropped = new Set<number>();
  for (const line of lines) {
    const m = line.match(/^(\d+)\.\s/);
    if (m) {
      const n = Number(m[1]);
      if ((FIX_RULE_NUMBERS as readonly number[]).includes(n)) {
        dropped.add(n);
        continue;
      }
    }
    kept.push(line);
  }
  for (const n of FIX_RULE_NUMBERS) {
    if (!dropped.has(n)) {
      throw new Error(
        `prompt-variants: expected rule ${n} to exist in director/system.md; template may have been rewritten — update FIX_RULE_NUMBERS or this eval.`,
      );
    }
  }
  return kept.join('\n');
}

export interface BuildArgs {
  agents: ScenarioAgent[];
  messages: OpenAIMessage[];
  agentResponses: AgentTurnSummary[];
  turnCount: number;
  discussionContext?: { topic: string; prompt?: string } | null;
  triggerAgentId?: string | null;
  userProfile?: { nickname?: string; bio?: string };
  whiteboardOpen?: boolean;
}

/**
 * Pre-#554 summarizeConversation: labels every role:'user' as [User] and
 * role:'assistant' as [Assistant], with no [senderName]: prefix stripping.
 * Used by the pre-fix variant so the eval A/B reflects both halves of #554
 * (the role-aware summary AND the new prompt rules), not just the rules.
 */
function summarizeConversationPreFix(
  messages: OpenAIMessage[],
  maxMessages = 10,
  maxContentLength = 200,
): string {
  if (messages.length === 0) return 'No conversation history yet.';
  const recent = messages.slice(-maxMessages);
  const lines = recent.map((msg) => {
    const roleLabel =
      msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Assistant' : 'System';
    const content =
      msg.content.length > maxContentLength
        ? msg.content.slice(0, maxContentLength) + '...'
        : msg.content;
    return `[${roleLabel}] ${content}`;
  });
  return lines.join('\n');
}

/**
 * Mirrors lib/orchestration/director-prompt.ts `buildDirectorPrompt()` shape
 * but lets us inject a pre-stripped template. Kept in sync with that file —
 * if you change variable names there, change them here.
 */
function buildPromptFromTemplate(
  template: string,
  args: BuildArgs,
  conversationSummary: string,
): string {
  const {
    agents,
    agentResponses,
    turnCount,
    discussionContext,
    triggerAgentId,
    userProfile,
    whiteboardOpen,
  } = args;

  const agentList = agents
    .map((a) => `- id: "${a.id}", name: "${a.name}", role: ${a.role}, priority: ${a.priority}`)
    .join('\n');

  const respondedList =
    agentResponses.length > 0
      ? agentResponses
          .map(
            (r) =>
              `- ${r.agentName} (${r.agentId}): "${r.contentPreview}" [${r.actionCount} actions]`,
          )
          .join('\n')
      : 'None yet.';

  const isDiscussion = !!discussionContext;
  const discussionSection = isDiscussion
    ? `\n# Discussion Mode\nTopic: "${discussionContext!.topic}"${discussionContext!.prompt ? `\nPrompt: "${discussionContext!.prompt}"` : ''}${triggerAgentId ? `\nInitiator: "${triggerAgentId}"` : ''}\nThis is a student-initiated discussion, not a Q&A session.\n`
    : '';

  const rule1 = isDiscussion
    ? `1. The discussion initiator${triggerAgentId ? ` ("${triggerAgentId}")` : ''} should speak first to kick off the topic. Then the teacher responds to guide the discussion. After that, other students may add their perspectives.`
    : "1. The teacher (role: teacher, highest priority) should usually speak first to address the user's question or topic.";

  const studentProfileSection =
    userProfile?.nickname || userProfile?.bio
      ? `\n# Student Profile\nStudent name: ${userProfile.nickname || 'Unknown'}\n${userProfile.bio ? `Background: ${userProfile.bio}` : ''}\n`
      : '';

  const vars: Record<string, unknown> = {
    agentList,
    respondedList,
    conversationSummary,
    discussionSection,
    whiteboardSection: '',
    studentProfileSection,
    rule1,
    turnCountPlusOne: turnCount + 1,
    whiteboardOpenText: whiteboardOpen
      ? 'OPEN (slide canvas is hidden — spotlight/laser will not work)'
      : 'CLOSED (slide canvas is visible)',
  };

  const withSnippets = processSnippets(template);
  const withConditionals = processConditionalBlocks(withSnippets, vars);
  return interpolateVariables(withConditionals, vars);
}

/**
 * Build both variants. The pre-fix variant uses both the old summary labels
 * ([User]/[Assistant]) AND the system.md without rules 10/11/12 — together
 * those are the full state of main^ relative to #554.
 */
export function buildVariants(args: BuildArgs): { preFix: string; postFix: string } {
  const post = readDirectorTemplate();
  const pre = stripFixRules(post);
  const postSummary = summarizeConversation(args.messages);
  const preSummary = summarizeConversationPreFix(args.messages);
  return {
    preFix: buildPromptFromTemplate(pre, args, preSummary),
    postFix: buildPromptFromTemplate(post, args, postSummary),
  };
}
