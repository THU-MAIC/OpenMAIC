import { test as base } from '@playwright/test';
import { MockApi } from './mock-api';

type Fixtures = {
  mockApi: MockApi;
  /** Answers the workspace model settings on every page (see MockApi.mockModelSettings). */
  modelSettings: void;
};

export const test = base.extend<Fixtures>({
  // Every page reads the workspace's model settings; by default a course
  // model is set up. A spec that needs another view calls
  // `mockApi.mockModelSettings(...)`, whose routes take precedence.
  modelSettings: [
    async ({ page }, use) => {
      await new MockApi(page).mockModelSettings();
      await use();
    },
    { auto: true },
  ],
  mockApi: async ({ page }, use) => {
    await use(new MockApi(page));
  },
});

export { expect } from '@playwright/test';
