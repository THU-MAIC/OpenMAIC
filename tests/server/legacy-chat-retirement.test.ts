import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('leaves the retired chat endpoint without an App Router or Pages Router handler', () => {
  // Middleware pass-through is covered in middleware-access-token.test.ts.
  // With no handler, Next owns the missing-route response.
  for (const extension of ['ts', 'tsx', 'js', 'jsx']) {
    for (const path of [
      `app/api/chat/route.${extension}`,
      `pages/api/chat.${extension}`,
      `pages/api/chat/index.${extension}`,
    ]) {
      expect(existsSync(resolve(__dirname, '../..', path)), path).toBe(false);
    }
  }
});
