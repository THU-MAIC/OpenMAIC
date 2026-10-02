import { createHmac, timingSafeEqual } from 'crypto';

import {
  isAccessTokenSignatureFormatValid,
  isAccessTokenTimestampValid,
} from './access-token-shared';

/** Create an HMAC-signed token: `timestamp.signature` */
export function createAccessToken(accessCode: string): string {
  const timestamp = Date.now().toString();
  const signature = createHmac('sha256', accessCode).update(timestamp).digest('hex');
  return `${timestamp}.${signature}`;
}

/** Verify an HMAC-signed token against the access code */
export function verifyAccessToken(token: string, accessCode: string): boolean {
  const dotIndex = token.indexOf('.');
  if (dotIndex === -1) return false;

  const timestamp = token.substring(0, dotIndex);
  const signature = token.substring(dotIndex + 1);

  // Reject expired, future-dated, and malformed timestamps before spending
  // work on the HMAC comparison.
  if (!isAccessTokenTimestampValid(timestamp)) return false;

  // Reject non-canonical signatures so this verifier agrees with the Edge one.
  if (!isAccessTokenSignatureFormatValid(signature)) return false;

  const expected = createHmac('sha256', accessCode).update(timestamp).digest('hex');

  const sigBuf = Buffer.from(signature, 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length) return false;

  return timingSafeEqual(sigBuf, expBuf);
}
