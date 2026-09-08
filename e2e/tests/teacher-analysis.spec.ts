import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';

test.skip(process.env.TEACHER_E2E_ENABLED !== '1', 'Requires the isolated local teacher database');

async function createStudent(page: Page, nickname: string) {
  await page.getByRole('button', { name: '新建学生', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('昵称', { exact: true }).fill(nickname);
  await dialog.getByRole('button', { name: '确认并保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('article', { name: '学生资料卡' })).toContainText(nickname);
}

test('real uploads and storage retain editable source-bound analysis without crossing students', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/teacher');
  await createStudent(page, '虚构分析学生甲');
  const students = (await (await page.request.get('/api/teacher/students')).json()).students;
  const profileId = students[0].profile.profileId;
  const path = `/api/teacher/students/${encodeURIComponent(profileId)}/analyses`;
  await page.getByRole('button', { name: '新建分析', exact: true }).click();
  const composer = page.getByTestId('teacher-analysis-composer');
  await composer.locator('#teacher-analysis-title').fill('虚构方程作业');
  await composer.locator('#teacher-analysis-subject').fill('数学');
  const chooserPromise = page.waitForEvent('filechooser');
  await composer.getByTestId('teacher-analysis-upload').click();
  await (
    await chooserPromise
  ).setFiles({
    name: 'fictional-homework.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Fictional student A. Question: 2x = 6. Student response: x = 3.'),
  });
  const role = composer.getByRole('combobox', {
    name: '资料用途: fictional-homework.txt',
    exact: true,
  });
  await expect(role).toBeVisible();
  await role.selectOption('student_work');
  const generatedResponse = page.waitForResponse(
    (response) => response.url().endsWith('/analyses') && response.request().method() === 'POST',
  );
  await composer.getByRole('button', { name: '生成分析', exact: true }).click();
  const generated = await generatedResponse;
  expect(generated.status()).toBe(201);
  const { analysis } = await generated.json();
  expect(analysis.status).toBe('draft');
  expect(analysis.report.readiness).toBe('insufficient');
  expect(analysis.sources[0].blocks[0].text).toContain('Student response: x = 3.');
  expect(JSON.stringify(analysis)).not.toContain('fictional-local-test-key');
  const detail = page.getByTestId('teacher-analysis-detail');
  await expect(detail).toBeVisible();
  await expect(detail).toContainText('inferred');
  await detail.locator('summary').filter({ hasText: '资料依据' }).click();
  await expect(detail.locator('blockquote')).toContainText('Student response: x = 3.');
  await expect(detail.locator('blockquote')).toBeVisible();
  await detail
    .getByTestId('analysis-observation-0')
    .fill('老师核对：本次写出了方程结果，下一课验证解题过程。');
  await detail.locator('#teacher-analysis-comment').fill('虚构安排：下次增加一道独立迁移题。');
  await expect(detail.getByRole('button', { name: '确认复核', exact: true })).toBeDisabled();
  await detail.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(detail.getByRole('button', { name: '确认复核', exact: true })).toBeEnabled();
  await detail.getByRole('button', { name: '确认复核', exact: true }).click();
  await expect(detail).toContainText('老师已复核');
  const detailPath = `${path}/${encodeURIComponent(analysis.analysisId)}`;
  const saved = (await (await page.request.get(detailPath)).json()).analysis;
  expect(saved.originalReport).toEqual(analysis.originalReport);
  expect(saved.sources).toEqual(analysis.sources);
  expect(saved.report.observations[0].text).toContain('老师核对');
  expect(saved.status).toBe('reviewed');
  const other = await browser.newContext({ baseURL });
  try {
    expect((await other.request.get(detailPath)).status()).toBe(404);
  } finally {
    await other.close();
  }
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`analysis-${width}.png`), fullPage: true });
  }
  await page.reload();
  await page.getByRole('button', { name: /虚构方程作业/ }).click();
  await expect(detail).toContainText('老师已复核');
  await detail.getByRole('button', { name: '撤回分析', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '撤回分析', exact: true }).click();
  await expect(detail).toContainText('已撤回');
  await createStudent(page, '虚构分析学生乙');
  await expect(page.getByText('暂无作业或考试分析记录', { exact: true })).toBeVisible();
  expect((await (await page.request.get(path)).json()).analyses).toHaveLength(1);
  expect(
    (
      await (
        await page.request.get(`/api/teacher/students/${encodeURIComponent(profileId)}`)
      ).json()
    ).student.profile,
  ).toEqual(students[0].profile);
  expect(errors).toEqual([]);
});

test('PDF page anchors, retry identity and failed recognition do not invent a saved report', async ({
  page,
}) => {
  await page.goto('/teacher');
  await createStudent(page, '虚构扫描与考试验收');
  const profileId = (await (await page.request.get('/api/teacher/students')).json()).students[0]
    .profile.profileId;
  const path = `/api/teacher/students/${encodeURIComponent(profileId)}/analyses`;
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage().drawText('Fictional paper. Question: 3x = 9. Student response: x = 3.', {
    x: 40,
    y: 700,
    size: 12,
    font,
  });
  const uploaded = await page.request.post('/api/materials', {
    headers: { 'content-type': 'application/pdf', 'x-material-filename': 'fictional-exam.pdf' },
    data: Buffer.from(await pdf.save()),
  });
  expect(uploaded.status()).toBe(201);
  const materialId = (await uploaded.json()).materialId;
  const request = {
    requestId: randomUUID(),
    workKind: 'monthly_exam',
    subject: 'Math',
    title: 'Fictional exam',
    workDate: '2026-09-08',
    teacherNotes: '',
    materials: [{ materialId, role: 'student_work' }],
  };
  const first = await page.request.post(path, { data: request });
  expect(first.status()).toBe(201);
  const analysis = (await first.json()).analysis;
  expect(analysis.sources[0].blocks[0].pageNumber).toBe(1);
  expect(analysis.sources[0].ocr).toBe(false);
  const retry = await page.request.post(path, { data: request });
  expect(retry.status()).toBe(200);
  expect((await retry.json()).analysis.analysisId).toBe(analysis.analysisId);
  const failed = await page.request.post(path, {
    data: { ...request, requestId: randomUUID(), teacherNotes: 'FICTIONAL_PROVIDER_FAILURE' },
  });
  expect(failed.status()).toBe(503);
  expect(await failed.json()).toEqual({ errorCode: 'ANALYSIS_MODEL_UNAVAILABLE' });
  const image = await page.request.post('/api/materials', {
    headers: { 'content-type': 'image/png', 'x-material-filename': 'fictional-scan.png' },
    data: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+afo0AAAAASUVORK5CYII=',
      'base64',
    ),
  });
  expect(image.status()).toBe(201);
  const scan = await page.request.post(path, {
    data: {
      ...request,
      requestId: randomUUID(),
      materials: [{ materialId: (await image.json()).materialId, role: 'student_work' }],
    },
  });
  expect(scan.status()).toBe(422);
  expect(await scan.json()).toEqual({ errorCode: 'ANALYSIS_OCR_REQUIRED' });
  expect((await (await page.request.get(path)).json()).analyses).toHaveLength(1);
});
