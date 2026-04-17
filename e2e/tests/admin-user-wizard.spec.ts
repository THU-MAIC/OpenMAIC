import { test, expect } from '../fixtures/base';

const adminEmail = process.env.ADMIN_E2E_EMAIL;
const adminPassword = process.env.ADMIN_E2E_PASSWORD;

test.describe('Admin User Wizard', () => {
  test.skip(!adminEmail || !adminPassword, 'Requires ADMIN_E2E_EMAIL and ADMIN_E2E_PASSWORD');

  test('creates a user via multi-step wizard and opens detail tabs', async ({ page }) => {
    const suffix = Date.now();
    const email = `e2e-user-${suffix}@example.com`;

    await page.goto('/auth/signin');
    await page.getByLabel('Email address').fill(adminEmail as string);
    await page.getByLabel('Password').fill(adminPassword as string);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(/\/admin(?:\?.*)?$/);

    await page.goto('/admin/users/new/identity');

    await page.getByLabel('Full name').fill(`E2E User ${suffix}`);
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Next' }).click();

    await page.getByLabel('Role').selectOption('STUDENT');
    await page.getByLabel('Student ID *').fill(`E2E-${suffix}`);
    await page.getByRole('button', { name: 'Next' }).click();

    await page.getByRole('button', { name: 'Next' }).click();

    await page.getByLabel('Password').fill('Aa12345678@');
    await page.getByRole('button', { name: 'Next' }).click();

    await page.getByRole('button', { name: 'Create user' }).click();

    await page.waitForURL(/\/admin\/users$/);
    await expect(page.getByText(email)).toBeVisible();

    await page.getByRole('link', { name: `E2E User ${suffix}` }).click();
    await page.waitForURL(/\/admin\/users\/.+$/);

    await page.getByRole('link', { name: 'Activity' }).click();
    await expect(page.getByRole('heading', { name: 'User Activity' })).toBeVisible();

    await page.getByRole('link', { name: 'Classrooms' }).click();
    await expect(page.getByRole('heading', { name: 'User Classrooms' })).toBeVisible();
  });
});
