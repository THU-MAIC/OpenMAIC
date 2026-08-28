import { createHash } from 'node:crypto';

import { CoachError } from '@/lib/zhongkao/coach-errors';

export const ZHONGKAO_OWNER_LEARNER_PREFIX = 'zhongkao-owner:v1:';
export const ZHONGKAO_OWNER_DIGEST_LENGTH = 64;
const UNPAIRED_SURROGATE = /[\uD800-\uDFFF]/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const MAX_LEARNER_KEY_LENGTH = 128;

/** Stable pseudonymous partition key. Authorization still uses the original owner/session. */
export function resolveZhongkaoLearnerKeyFromOwnerId(ownerId: string): string {
  if (
    typeof ownerId !== 'string' ||
    ownerId.length === 0 ||
    ownerId !== ownerId.trim() ||
    CONTROL_CHARACTER.test(ownerId) ||
    UNPAIRED_SURROGATE.test(ownerId)
  ) {
    throw new CoachError('COACH_INPUT_INVALID');
  }
  const digest = createHash('sha256')
    .update('openmaic:zhongkao-owner:v1')
    .update('\0')
    .update(ownerId, 'utf8')
    .digest('hex');
  const learnerKey = `${ZHONGKAO_OWNER_LEARNER_PREFIX}${digest}`;
  if (digest.length !== ZHONGKAO_OWNER_DIGEST_LENGTH) {
    throw new CoachError('COACH_RUNTIME_UNAVAILABLE');
  }
  if (learnerKey.length > MAX_LEARNER_KEY_LENGTH) {
    throw new CoachError('COACH_INPUT_INVALID');
  }
  return learnerKey;
}
