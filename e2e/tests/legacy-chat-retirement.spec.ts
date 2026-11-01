import { expect, test } from '@playwright/test';

// The legacy director-graph classroom chat route was removed without a stub,
// redirect or migration handler, so the running app answers with Next's own 404.
// Assumes the server runs without ACCESS_CODE, as the CI E2E job does; the
// access-code 401 is covered by tests/server/middleware-access-token.test.ts.
test('POST /api/chat is no longer served', async ({ request }) => {
  const response = await request.post('/api/chat', {
    data: { messages: [], storeState: { scenes: [] }, config: { agentIds: ['default-1'] } },
    maxRedirects: 0,
  });

  expect(response.status()).toBe(404);
});
