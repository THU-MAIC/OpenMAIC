import type { ChatGPTPlanUnavailableReason } from '@/lib/chatgpt-plan/shared';
import { createLogger } from '@/lib/logger';
import { isPersonalInstallation } from '@/lib/server/identity';

const log = createLogger('ChatGPT Plan');

export type ChatGPTPlanAvailability =
  | { available: true }
  | { available: false; reason: ChatGPTPlanUnavailableReason };

/** The operator's switch, read on the server at runtime. */
function isEnabled(): boolean {
  const value = process.env.OPENMAIC_CHATGPT_PLAN_ENABLED;
  return value === 'true' || value === '1';
}

/**
 * Plan usage is for the person who owns the ChatGPT subscription, so the
 * provider is offered only when the operator turned it on and the installation
 * is a personal one (single-user sign-in). Routes still check that the caller
 * is that installation's owner.
 */
export function chatGPTPlanAvailability(): ChatGPTPlanAvailability {
  if (!isEnabled()) return { available: false, reason: 'disabled' };
  if (!isPersonalInstallation()) return { available: false, reason: 'not-personal-installation' };
  return { available: true };
}

/** Startup check: explain why a requested provider stays off. */
export function warnAboutChatGPTPlanConfiguration(): void {
  const availability = chatGPTPlanAvailability();
  if (!availability.available && availability.reason === 'not-personal-installation') {
    log.warn(
      'OPENMAIC_CHATGPT_PLAN_ENABLED is set, but this installation is not a personal one, so the ChatGPT plan provider stays off. It is available with single-user sign-in, where the person who owns the ChatGPT subscription is the only user.',
    );
  }
}
