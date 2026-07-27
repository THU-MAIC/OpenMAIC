import { test as base } from '@playwright/test';
import { MockApi } from './mock-api';

type Fixtures = {
  mockApi: MockApi;
};

export const test = base.extend<Fixtures>({
  mockApi: async ({ page }, use) => {
    const mockApi = new MockApi(page);
    // Always mock server-providers — called on every page load by root layout
    await mockApi.mockServerProviders();
    // Classroom and generation pages correctly require a Supabase account.
    // Keep E2E authenticated through the normal browser-client code path.
    await mockApi.mockAuthenticatedUser();
    await use(mockApi);
  },
});

export { expect } from '@playwright/test';
