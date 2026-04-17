import { test, expect } from '../fixtures/base';

const adminEmail = process.env.ADMIN_E2E_EMAIL;
const adminPassword = process.env.ADMIN_E2E_PASSWORD;

test.describe('Instructor Workflow', () => {
  test.skip(!adminEmail || !adminPassword, 'Requires ADMIN_E2E_EMAIL and ADMIN_E2E_PASSWORD');

  test('creates classroom via instructor wizard and updates gradebook', async ({ page }) => {
    test.setTimeout(120_000);

    const suffix = Date.now();
    const classroomTitle = `Instructor E2E ${suffix}`;
    const classroomDescription = `Prompt seed for instructor flow ${suffix}`;

    // Sign in (admin can access instructor area by design)
    await page.goto('/auth/signin');
    await page.getByPlaceholder('admin@school.ac.th').fill(adminEmail as string);
    await page.getByPlaceholder('••••••••').fill(adminPassword as string);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await page.waitForURL((url) => !url.pathname.startsWith('/auth/signin'));
    await expect(page).not.toHaveURL(/\/auth\/signin/);

    // Start wizard
    await page.goto('/instructor/classrooms/new/step/basics');
    await page.locator('#title').fill(classroomTitle);
    await page.locator('#description').fill(classroomDescription);
    await page.getByRole('button', { name: 'Next: Content' }).click();

    await page.getByRole('button', { name: 'Next: Students' }).click();
    await page.getByRole('button', { name: 'Next: Review' }).click();
    await page.getByRole('button', { name: 'Create Classroom' }).click();

    // Redirect to home prompt box with classroom description prefilled
    await page.waitForURL((url) => url.pathname === '/');
    await expect(page.locator('textarea').first()).toHaveValue(classroomDescription);

    // Open the newly created classroom from recent list and capture classroom ID
    await page.getByText(classroomTitle).first().click();
    await page.waitForURL((url) => url.pathname.startsWith('/classroom/'));
    const classroomPathMatch = page.url().match(/\/classroom\/([^/?]+)/);
    expect(classroomPathMatch?.[1]).toBeTruthy();
    const classroomId = classroomPathMatch![1];

    // Open grades tab and verify empty state first
    await page.goto(`/instructor/classrooms/${classroomId}/grades`);
    await expect(page.getByText('No quiz results yet')).toBeVisible();

    // Seed one quiz result via API
    const seedRes = await page.request.post(`/api/instructor/classrooms/${classroomId}/grades`, {
      data: {
        studentLabel: 'E2E Student',
        sceneId: `scene-${suffix}`,
        sceneTitle: 'Cell Structure Quiz',
        score: 8,
        maxScore: 10,
        answers: [
          {
            questionId: 'q1',
            answer: 'The nucleus controls cell activities.',
            score: 8,
            comment: 'Good understanding',
          },
        ],
        gradedBy: 'ai',
      },
    });
    expect(seedRes.ok()).toBeTruthy();

    // Reload and verify gradebook table reflects the result
    await page.reload();
    const studentRow = page.getByRole('row').filter({ hasText: 'E2E Student' });
    await expect(studentRow).toBeVisible();
    await expect(studentRow.locator('td').last()).toHaveText('8/10');
  });
});
