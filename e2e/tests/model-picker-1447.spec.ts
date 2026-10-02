import { test, expect } from '../fixtures/base';

// These are deliberate repeated-open stress cases. Parallel dev-server runs
// can spend most of the default 30s budget compiling before the ten cycles.
test.describe.configure({ timeout: 60_000 });

for (const method of ['click', 'Enter', 'Space']) {
  test(`model picker selects and closes with ${method}`, async ({ page, mockApi }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await mockApi.mockModelSettings({
      providers: { openai: ['gpt-4o', 'gpt-4o-mini'], anthropic: ['claude-sonnet-4-6'] },
      llm: 'openai:gpt-4o',
    });
    await page.goto('/');
    const picker = page.locator('button[aria-label*=" / "]').first();
    await expect(picker).toBeVisible();
    for (let i = 0; i < 10; i++) {
      await picker.click();
      const dialog = page.getByRole('dialog');
      const modelId = i % 2 === 0 ? 'gpt-4o-mini' : 'gpt-4o';
      const row = dialog
        .locator('div[role="button"]')
        .filter({ has: page.getByText(modelId, { exact: true }) });
      if (method === 'click') await row.click();
      else {
        await row.focus();
        await row.press(method);
      }
      await expect(dialog).toBeHidden();
      await expect(picker).toHaveAttribute('aria-label', `OpenAI / ${modelId}`);
    }
    expect(errors).toEqual([]);
  });
}

test('provider switch and repeated dismissal remain usable', async ({ page, mockApi }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mockApi.mockModelSettings({
    providers: { openai: ['gpt-4o'], anthropic: ['claude-sonnet-4-6'] },
    llm: 'openai:gpt-4o',
  });
  await page.goto('/');
  const picker = page.locator('button[aria-label*=" / "]').first();
  await picker.click();
  let dialog = page.getByRole('dialog');
  // Providers are group headings (not tabs), so a provider switch is just
  // selecting a row from the Claude group; it sets the workspace's llm slot.
  await dialog.locator('div[role="button"]').filter({ hasText: 'claude-sonnet-4-6' }).click();
  await expect(dialog).toBeHidden();
  await expect(picker).toHaveAttribute('aria-label', /Claude/);
  for (let i = 0; i < 10; i++) {
    await picker.click();
    dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  }
  expect(errors).toEqual([]);
});

test('outside click closes and keyboard dismissal restores trigger focus', async ({
  page,
  mockApi,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mockApi.mockModelSettings({ providers: { openai: ['gpt-4o'] }, llm: 'openai:gpt-4o' });
  await page.goto('/');
  const picker = page.locator('button[aria-label*=" / "]').first();
  await picker.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  await page.locator('body').click({ position: { x: 5, y: 5 } });

  await expect(dialog).toBeHidden();

  await picker.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(picker).toBeFocused();
  expect(errors).toEqual([]);
});
