import { test, expect } from '../fixtures/base';

const adminEmail = process.env.ADMIN_E2E_EMAIL;
const adminPassword = process.env.ADMIN_E2E_PASSWORD;

test.describe('Admin Classroom Wizard', () => {
  test.skip(!adminEmail || !adminPassword, 'Requires ADMIN_E2E_EMAIL and ADMIN_E2E_PASSWORD');

  test('creates a classroom via multi-step wizard and opens detail tabs', async ({ page }) => {
    const suffix = Date.now();
    const classroomId = `E2E_CLASS_${suffix}`;

    await page.goto('/auth/signin');
    await page.getByLabel('Email address').fill(adminEmail as string);
    await page.getByLabel('Password').fill(adminPassword as string);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(/\/admin(?:\?.*)?$/);

    await page.goto('/admin/classrooms/new/basics');

    await page.getByLabel('Classroom ID').fill(classroomId);
    await page.getByLabel('Title').fill(`E2E Classroom ${suffix}`);
    await page.getByRole('button', { name: 'Next' }).click();

    await page.getByLabel('Content source').selectOption('blank');
    await page.getByRole('button', { name: 'Next' }).click();

    await page.getByRole('button', { name: 'Next' }).click();

    await page.getByLabel('Pacing mode').selectOption('self_paced');
    await page.getByRole('button', { name: 'Next' }).click();

    await page.getByRole('button', { name: 'Create classroom' }).click();

    await page.waitForURL(/\/admin\/classrooms$/);
    await expect(page.getByText(classroomId)).toBeVisible();

    await page.getByRole('link', { name: 'Manage' }).first().click();
    await page.waitForURL(/\/admin\/classrooms\/.+\/overview$/);

    await page.getByRole('link', { name: 'Students' }).click();
    await expect(page.getByRole('heading', { name: 'Students' })).toBeVisible();

    await page.getByRole('link', { name: 'Content' }).click();
    await expect(page.getByRole('heading', { name: 'Content' })).toBeVisible();

    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  });
});
