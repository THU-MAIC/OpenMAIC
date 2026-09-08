import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

test.skip(process.env.TEACHER_E2E_ENABLED !== '1', 'Requires the isolated local teacher database');

async function createStudent(page: Page, nickname: string) {
  await page.getByRole('button', { name: '新建学生', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('昵称', { exact: true }).fill(nickname);
  await dialog.getByRole('button', { name: '确认并保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('article', { name: '学生资料卡' })).toContainText(nickname);
}

async function checkLayout(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await expect(page.getByRole('img', { name: 'OpenMAIC', exact: true })).toBeVisible();
  expect(
    await page
      .getByRole('img', { name: 'OpenMAIC', exact: true })
      .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
  ).toBe(true);
}

test('real storage preserves cold-start profiles and isolates teacher identities', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL });
  const other = await browser.newContext({ baseURL });
  try {
    const api = context.request;
    expect((await api.get('/api/teacher/students')).status()).toBe(200);
    const fields = { nickname: '虚构验收甲', grade: null, examYear: null, region: null };
    const data = { ...fields, requestId: randomUUID() };
    const created = await api.post('/api/teacher/students', { data });
    expect(created.status()).toBe(201);
    const { student } = await created.json();
    expect(student.profile.grade).toMatchObject({ value: null, status: 'unknown' });
    expect(student.profile.examYear).toMatchObject({ value: null, status: 'unknown' });
    expect(student.profile.textbookVersions).toEqual({});
    const replayed = await api.post('/api/teacher/students', { data });
    expect(replayed.status()).toBe(200);
    expect((await replayed.json()).student.profile.profileId).toBe(student.profile.profileId);
    expect((await (await api.get('/api/teacher/students')).json()).students).toHaveLength(1);
    const path = `/api/teacher/students/${encodeURIComponent(student.profile.profileId)}`;
    expect((await other.request.get(path)).status()).toBe(404);
    expect((await (await other.request.get('/api/teacher/students')).json()).students).toEqual([]);
    const update = {
      ...fields,
      grade: 9,
      examYear: 2027,
      archived: false,
      expectedUpdatedAt: student.profile.updatedAt,
    };
    expect((await api.patch(path, { data: update })).status()).toBe(200);
    expect((await api.patch(path, { data: update })).status()).toBe(409);
    const current = (await (await api.get(path)).json()).student;
    expect(current.profile.grade).toMatchObject({ value: 9, status: 'confirmed' });
    expect(current.profile.region).toMatchObject({ value: null, status: 'unknown' });
    expect(
      (
        await api.post('/api/teacher/students', {
          data: { ...data, requestId: randomUUID() },
          headers: { Origin: 'https://unrelated.example', 'Sec-Fetch-Site': 'cross-site' },
        })
      ).status(),
    ).toBe(403);
  } finally {
    await context.close();
    await other.close();
  }
});

test('teacher can manage students and recover the workspace on desktop and mobile', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto('/teacher');
  await expect(page.getByRole('heading', { name: '教师工作台', exact: true })).toBeVisible();
  await expect(page.getByText('还没有学生档案', { exact: true })).toBeVisible();
  await createStudent(page, '虚构学生小禾');
  const profile = page.getByRole('article', { name: '学生资料卡' });
  await expect(profile).toContainText('探索计划');
  await expect(profile).not.toContainText('2027');
  await createStudent(page, '虚构学生小林');
  await page.getByRole('button', { name: '编辑资料', exact: true }).click();
  await page.getByLabel('年级 选填').fill('9');
  await page.getByLabel('考试年份 选填').fill('2027');
  const savedStudents = (await (await page.request.get('/api/teacher/students')).json()).students;
  const concurrentStudent = savedStudents.find(
    (item: { profile: { displayName: { value: string } } }) =>
      item.profile.displayName.value === '虚构学生小林',
  );
  const concurrent = await page.request.patch(
    `/api/teacher/students/${encodeURIComponent(concurrentStudent.profile.profileId)}`,
    {
      data: {
        nickname: '虚构学生小林',
        grade: null,
        examYear: null,
        region: '虚构地区',
        archived: false,
        expectedUpdatedAt: concurrentStudent.profile.updatedAt,
      },
    },
  );
  expect(concurrent.status()).toBe(200);
  await page.getByRole('button', { name: '确认并保存', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('资料已在其他页面更新');
  await page.getByRole('button', { name: '刷新资料并保留草稿', exact: true }).click();
  await expect(page.getByLabel('地区 选填')).toHaveValue('虚构地区');
  await expect(page.getByLabel('年级 选填')).toHaveValue('9');
  await page.getByRole('button', { name: '确认并保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(profile).toContainText('2027');
  await page.reload();
  await page.getByRole('searchbox', { name: '搜索学生昵称' }).fill('小禾');
  await expect(profile).toContainText('虚构学生小禾');
  await expect(profile).not.toContainText('2027');
  await page.getByRole('searchbox', { name: '搜索学生昵称' }).fill('小林');
  await expect(profile).toContainText('2027');
  await page.getByRole('searchbox', { name: '搜索学生昵称' }).fill('');
  await page
    .getByRole('complementary', { name: '学生档案' })
    .getByRole('button', { name: /虚构学生小林/ })
    .click();
  await checkLayout(page);
  await page.screenshot({ path: testInfo.outputPath('teacher-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: '归档学生', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '归档学生', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '已归档', exact: true }).click();
  await expect(profile).toContainText('虚构学生小林');
  await page.getByRole('button', { name: '恢复学生', exact: true }).click();
  await expect(page.getByText('暂无归档学生', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '在读', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await checkLayout(page);
  await page.screenshot({ path: testInfo.outputPath('teacher-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: '新建学生', exact: true }).first().click();
  await page.getByLabel('昵称', { exact: true }).fill('虚构长昵称'.repeat(12));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const dialogBounds = await page.getByRole('dialog').boundingBox();
  expect(dialogBounds!.width).toBeLessThanOrEqual(390);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.setViewportSize({ width: 320, height: 740 });
  await createStudent(page, 'FictionalStudent' + 'x'.repeat(64));
  await checkLayout(page);
  await page.screenshot({ path: testInfo.outputPath('teacher-mobile-320.png'), fullPage: true });
  await page.getByRole('button', { name: '工作区恢复', exact: true }).click();
  const recovery = page.locator('#teacher-recovery-code');
  await expect(recovery).not.toHaveValue('');
  const recoveryCode = await recovery.inputValue();
  expect(
    await page.evaluate(() =>
      Object.values(localStorage).some((value) => value.includes('openmaic-teacher-v1:')),
    ),
  ).toBe(false);
  const recovered = await browser.newContext({
    baseURL,
    locale: 'zh-CN',
    viewport: { width: 390, height: 844 },
  });
  try {
    const recoveredPage = await recovered.newPage();
    await recoveredPage.goto('/teacher');
    await expect(recoveredPage.getByText('还没有学生档案', { exact: true })).toBeVisible();
    await recoveredPage.getByRole('button', { name: '工作区恢复', exact: true }).click();
    await recoveredPage.getByRole('button', { name: '恢复其他工作区', exact: true }).click();
    await recoveredPage.locator('#teacher-restore-code').fill(recoveryCode);
    await recoveredPage.getByRole('button', { name: '确认切换工作区', exact: true }).click();
    await expect(recoveredPage.getByRole('dialog')).toHaveCount(0);
    const roster = recoveredPage.getByRole('complementary', { name: '学生档案' });
    await expect(roster).toContainText('虚构学生小林');
    await expect(roster).toContainText('虚构学生小禾');
    await checkLayout(recoveredPage);
  } finally {
    await recovered.close();
  }
  expect(pageErrors).toEqual([]);
});
