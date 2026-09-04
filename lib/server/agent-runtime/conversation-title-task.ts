import { after } from 'next/server';

import { createLogger } from '@/lib/logger';
import { generateConversationTitle } from './conversation-title-generator';
import { getAgentSessionStore } from './store';

const log = createLogger('ConversationTitleTask');

async function runConversationTitleTask(sessionId: string, ownerId: string): Promise<void> {
  let store: Awaited<ReturnType<typeof getAgentSessionStore>>;
  let visibleUserText: string | null;
  try {
    store = await getAgentSessionStore();
    visibleUserText = await store.claimAutomaticSessionTitle(sessionId, ownerId);
  } catch (error) {
    log.error(`session ${sessionId}: automatic title claim failed`, error);
    return;
  }
  if (visibleUserText === null) return;

  let title: string | null;
  try {
    title = await generateConversationTitle(visibleUserText);
  } catch (error) {
    log.error(`session ${sessionId}: automatic title generation failed`, error);
    return;
  }
  if (title === null) return;

  try {
    await store.setAutomaticSessionTitle(sessionId, ownerId, title);
  } catch (error) {
    log.error(`session ${sessionId}: automatic title commit failed`, error);
  }
}

export function scheduleConversationTitle(sessionId: string, ownerId: string): void {
  try {
    after(() => runConversationTitleTask(sessionId, ownerId));
  } catch (error) {
    log.error(`session ${sessionId}: automatic title scheduling failed`, error);
  }
}
