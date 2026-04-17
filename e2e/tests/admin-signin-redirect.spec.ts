import { test, expect } from '../fixtures/base';

const adminEmail = process.env.ADMIN_E2E_EMAIL;
const adminPassword = process.env.ADMIN_E2E_PASSWORD;

test.describe('Admin Sign-in Redirect', () => {
  test.skip(!adminEmail || !adminPassword, 'Requires ADMIN_E2E_EMAIL and ADMIN_E2E_PASSWORD');

  test('redirects admin directly to admin dashboard after sign-in', async ({ page }) => {
    await page.goto('/auth/signin');
    await page.getByLabel('Email address').fill(adminEmail as string);
    await page.getByLabel('Password').fill(adminPassword as string);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await page.waitForURL(/\/admin(?:\?.*)?$/);
    await expect(page).toHaveURL(/\/admin(?:\?.*)?$/);
  });
});
