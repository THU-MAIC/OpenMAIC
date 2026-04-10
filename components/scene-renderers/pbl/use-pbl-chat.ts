'use client';

/**
 * PBL Chat Hook - Manages chat state, @mention parsing, and API calls
 */

import { useState, useCallback } from 'react';
import type { PBLProjectConfig, PBLChatMessage, PBLAgent, PBLIssue } from '@/lib/pbl/types';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createLogger } from '@/lib/logger';

const log = createLogger('PBLChat');

interface UsePBLChatOptions {
  projectConfig: PBLProjectConfig;
  userRole: string;
  onConfigUpdate: (config: PBLProjectConfig) => void;
}

export function usePBLChat({ projectConfig, userRole, onConfigUpdate }: UsePBLChatOptions) {
  const { t } = useI18n();
  const [isLoading, setIsLoading] = useState(false);

  const messages = projectConfig.chat.messages;

  const currentIssue = projectConfig.issueboard.issues.find((i) => i.is_active) || null;

  const sendMessage = useCallback(
    async (text: string) => {
      if (!text.trim() || isLoading) return;

      const updatedConfig = {
        ...projectConfig,
        chat: {
          ...projectConfig.chat,
          messages: [...projectConfig.chat.messages],
        },
      };

      // Add user message
      const userMsg: PBLChatMessage = {
        id: `msg_${Date.now()}_user`,
        agent_name: userRole,
        message: text,
        timestamp: Date.now(),
        read_by: [userRole],
      };
      updatedConfig.chat.messages.push(userMsg);
      onConfigUpdate(updatedConfig);

      // Parse @mention to determine target agent, fallback to question agent
      const targetAgent = resolveTargetAgent(text, currentIssue, projectConfig.agents);
      if (!targetAgent) return;

      setIsLoading(true);

      try {
        const modelConfig = getCurrentModelConfig();
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'x-model': modelConfig.modelString,
          'x-api-key': modelConfig.apiKey,
        };
        if (modelConfig.baseUrl) headers['x-base-url'] = modelConfig.baseUrl;
        if (modelConfig.providerType) headers['x-provider-type'] = modelConfig.providerType;

        // Strip @mention prefix from message text if present
        const cleanMessage = text.replace(/^@\w+\s*/i, '').trim() || text;

        const isJudgeAgent = currentIssue && targetAgent.name === currentIssue.judge_agent_name;

        const response = await fetch('/api/pbl/chat', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            message: cleanMessage,
            agent: targetAgent,
            currentIssue,
            recentMessages: updatedConfig.chat.messages.slice(-10).map((m) => ({
              agent_name: m.agent_name,
              message: m.message,
            })),
            userRole,
            agentType: isJudgeAgent ? 'judge' : 'question',
          }),
        });

        const data = await response.json();

        if (data.success) {
          const agentMsg: PBLChatMessage = {
            id: `msg_${Date.now()}_agent`,
            agent_name: targetAgent.name,
            message: data.message,
            timestamp: Date.now(),
            read_by: [],
          };

          const afterConfig = {
            ...updatedConfig,
            chat: { messages: [...updatedConfig.chat.messages, agentMsg] },
          };

          // Check for COMPLETE from judge agent (excluding NEEDS_REVISION)
          const msgUpper = data.message.toUpperCase();
          if (
            currentIssue &&
            isJudgeAgent &&
            msgUpper.includes('COMPLETE') &&
            !msgUpper.includes('NEEDS_REVISION')
          ) {
            await handleIssueComplete(afterConfig, currentIssue, headers, t);
          }

          onConfigUpdate(afterConfig);
        }
      } catch (error) {
        log.error('[usePBLChat] Error:', error);
      } finally {
        setIsLoading(false);
      }
    },
    [projectConfig, userRole, currentIssue, isLoading, onConfigUpdate, t],
  );

  return { messages, isLoading, sendMessage, currentIssue };
}

/**
 * Resolve target agent from @mention, or fallback to question agent for plain messages
 */
function resolveTargetAgent(
  text: string,
  currentIssue: PBLIssue | null,
  agents: PBLAgent[],
): PBLAgent | null {
  if (!currentIssue) return null;

  const mentionMatch = text.match(/^@(\w+)/i);
  if (mentionMatch) {
    const mentionType = mentionMatch[1].toLowerCase();

    if (mentionType === 'question') {
      return agents.find((a) => a.name === currentIssue.question_agent_name) || null;
    }
    if (mentionType === 'judge') {
      return agents.find((a) => a.name === currentIssue.judge_agent_name) || null;
    }

    // Direct agent name mention
    const matched = agents.find((a) => a.name.toLowerCase().includes(mentionType));
    if (matched) return matched;
  }

  // No @mention or unrecognized mention → route to question agent by default
  return agents.find((a) => a.name === currentIssue.question_agent_name) || null;
}

/**
 * Handle issue completion: mark done, activate next, generate questions for next issue
 */
async function handleIssueComplete(
  config: PBLProjectConfig,
  completedIssue: PBLIssue,
  headers: Record<string, string>,
  t: (key: string, options?: Record<string, unknown>) => string,
) {
  // Mark current issue as done
  const issue = config.issueboard.issues.find((i) => i.id === completedIssue.id);
  if (issue) {
    issue.is_done = true;
    issue.is_active = false;
  }
  config.issueboard.current_issue_id = null;

  // Activate next incomplete issue
  const nextIssue = config.issueboard.issues
    .filter((i) => !i.is_done)
    .sort((a, b) => a.index - b.index)[0];

  if (nextIssue) {
    nextIssue.is_active = true;
    config.issueboard.current_issue_id = nextIssue.id;

    // Generate questions for the new issue if not already generated
    const questionAgent = config.agents.find((a) => a.name === nextIssue.question_agent_name);
    if (questionAgent && !nextIssue.generated_questions) {
      try {
        const questionPrompt = [
          `## Issue Information`,
          ``,
          `**Title**: ${nextIssue.title}`,
          `**Description**: ${nextIssue.description}`,
          `**Person in Charge**: ${nextIssue.person_in_charge}`,
          nextIssue.participants.length > 0
            ? `**Participants**: ${nextIssue.participants.join(', ')}`
            : '',
          nextIssue.notes ? `**Notes**: ${nextIssue.notes}` : '',
          ``,
          `## Your Task`,
          ``,
          `Based on the issue information above, generate 1-3 specific, actionable questions that will help students understand and complete this issue. Format your response as a numbered list.`,
        ]
          .filter(Boolean)
          .join('\n');

        const resp = await fetch('/api/pbl/chat', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            message: questionPrompt,
            agent: questionAgent,
            currentIssue: nextIssue,
            recentMessages: [],
            userRole: '',
          }),
        });

        const data = await resp.json();
        if (data.success && data.message) {
          nextIssue.generated_questions = data.message;

          // Add Question Agent welcome message
          config.chat.messages.push({
            id: `msg_${Date.now()}_welcome`,
            agent_name: nextIssue.question_agent_name,
            message: t('pbl.chat.welcomeMessage', {
              title: nextIssue.title,
              questions: data.message,
            }),
            timestamp: Date.now(),
            read_by: [],
          });
        }
      } catch (error) {
        log.error('[usePBLChat] Failed to generate questions for next issue:', error);
      }
    } else if (questionAgent && nextIssue.generated_questions) {
      // Questions already exist, just add welcome message
      config.chat.messages.push({
        id: `msg_${Date.now()}_welcome`,
        agent_name: nextIssue.question_agent_name,
        message: t('pbl.chat.welcomeMessage', {
          title: nextIssue.title,
          questions: nextIssue.generated_questions,
        }),
        timestamp: Date.now(),
        read_by: [],
      });
    }

    // System message about progression
    config.chat.messages.push({
      id: `msg_${Date.now()}_system`,
      agent_name: 'System',
      message: t('pbl.chat.issueCompleteMessage', {
        completed: completedIssue.title,
        next: nextIssue.title,
      }),
      timestamp: Date.now(),
      read_by: [],
    });
  } else {
    // All issues complete
    config.chat.messages.push({
      id: `msg_${Date.now()}_system`,
      agent_name: 'System',
      message: t('pbl.chat.allCompleteMessage'),
      timestamp: Date.now(),
      read_by: [],
    });
  }
}
