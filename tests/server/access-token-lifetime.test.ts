import { createHmac } from 'crypto';
import { describe, expect, test } from 'vitest';

import { verifyAccessToken } from '@/lib/server/access-token';
import { verifyAccessTokenEdge } from '@/lib/server/access-token-edge';
import {
  ACCESS_TOKEN_CLOCK_SKEW_SECONDS,
  ACCESS_TOKEN_MAX_AGE_MS,
} from '@/lib/server/access-token-shared';

const CODE = 'demo-code';

/**
 * Build a token whose signature is genuinely valid for `timestamp`, so a
 * rejection proves the timestamp policy rejected it rather than a bad HMAC.
 */
function signedToken(timestamp: string, code = CODE): string {
  const signature = createHmac('sha256', code).update(timestamp).digest('hex');
  return `${timestamp}.${signature}`;
}

// Both verifiers — the Node one and the Edge/Web Crypto one used by middleware —
// must enforce the same lifetime policy.
const verifiers: Array<[string, (token: string) => Promise<boolean>]> = [
  ['verifyAccessToken (Node)', async (token) => verifyAccessToken(token, CODE)],
  ['verifyAccessTokenEdge (middleware)', (token) => verifyAccessTokenEdge(token, CODE)],
];

const now = Date.now();

for (const [name, verify] of verifiers) {
  describe(`access token lifetime — ${name}`, () => {
    test('accepts a fresh, correctly signed token', async () => {
      await expect(verify(signedToken(String(now)))).resolves.toBe(true);
    });

    test('accepts a token within the clock-skew allowance', async () => {
      const timestamp = String(now + ACCESS_TOKEN_CLOCK_SKEW_SECONDS * 1000);
      await expect(verify(signedToken(timestamp))).resolves.toBe(true);
    });

    test('rejects a token older than the max age', async () => {
      const timestamp = String(now - ACCESS_TOKEN_MAX_AGE_MS - 1000);
      await expect(verify(signedToken(timestamp))).resolves.toBe(false);
    });

    test('rejects a token dated beyond the clock-skew allowance', async () => {
      const timestamp = String(now + ACCESS_TOKEN_CLOCK_SKEW_SECONDS * 1000 + 1000);
      await expect(verify(signedToken(timestamp))).resolves.toBe(false);
    });

    test('rejects a non-numeric timestamp', async () => {
      await expect(verify(signedToken('not-a-number'))).resolves.toBe(false);
    });

    test('rejects a hexadecimal timestamp', async () => {
      await expect(verify(signedToken('0x1f'))).resolves.toBe(false);
    });

    test('rejects a decimal timestamp', async () => {
      await expect(verify(signedToken('1700000000000.5'))).resolves.toBe(false);
    });

    test('rejects an empty timestamp', async () => {
      await expect(verify(signedToken(''))).resolves.toBe(false);
    });
  });
}

// The Node verifier's `Buffer.from(sig, 'hex')` accepts uppercase hex and stops
// at the first non-hex character unless the shared signature-format check runs,
// so these cases would make the two verifiers disagree. `verifyAccessToken` is
// synchronous and `verifyAccessTokenEdge` returns a promise.
describe('access token signature format — both verifiers agree', () => {
  async function expectBothReject(token: string): Promise<void> {
    expect(verifyAccessToken(token, CODE)).toBe(false);
    await expect(verifyAccessTokenEdge(token, CODE)).resolves.toBe(false);
  }

  test('rejects an uppercase-hex signature', async () => {
    const [timestamp, signature] = signedToken(String(now)).split('.');
    await expectBothReject(`${timestamp}.${signature.toUpperCase()}`);
  });

  test('rejects a valid signature followed by junk', async () => {
    const [timestamp, signature] = signedToken(String(now)).split('.');
    await expectBothReject(`${timestamp}.${signature}zz`);
  });

  test('rejects a signature that is valid hex but too short', async () => {
    const [timestamp, signature] = signedToken(String(now)).split('.');
    await expectBothReject(`${timestamp}.${signature.slice(0, 62)}`);
  });
});
