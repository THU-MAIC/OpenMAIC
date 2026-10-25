import { test, expect } from '../fixtures/base';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import { createMockScene } from '../fixtures/test-data/generated-scene';
import { seedServerDocument, readServerDocument, uniqueStageId } from '../fixtures/server-seed';

test('legacy shape labels keep imported insets through editing and reload', async ({
  page,
}, testInfo) => {
  await page.addInitScript(
    (settings) => {
      localStorage.setItem('maic:account:settings-storage', settings);
      localStorage.setItem('locale', 'en-US');
    },
    createSettingsStorage({ sidebarCollapsed: false }),
  );
  await page.goto('/');
  const stageId = uniqueStageId('e2e-label-insets');
  const scene = createMockScene(stageId);
  const labels = [
    {
      id: 'zero',
      content:
        '<div data-pptx-text-insets="true" style="padding: 0pt"><p style="font-size: 28px">Zero inset</p></div>',
      outer: '0px',
      inner: '0px',
    },
    {
      id: 'imported',
      content:
        '<div data-pptx-text-insets="true" style="padding: 7.2pt"><p style="font-size: 28px">7.2pt inset</p></div>',
      outer: '0px',
      inner: '9.6px',
    },
    {
      id: 'authored',
      content: '<p style="font-size: 28px">Authored 10px</p>',
      outer: '10px',
      inner: null,
    },
  ];
  const elements = labels.map((label, index) => ({
    id: label.id,
    type: 'shape',
    left: 40 + index * 320,
    top: 130,
    width: 280,
    height: 160,
    rotate: 0,
    viewBox: [280, 160],
    path: 'M 0 0 L 280 0 L 280 160 L 0 160 Z',
    fixedRatio: false,
    fill: '#e2e8f0',
    text: {
      content: label.content,
      align: 'top',
      defaultColor: '#111827',
      defaultFontName: 'Arial',
    },
  }));
  await seedServerDocument(page, {
    stage: {
      id: stageId,
      name: 'Imported label insets',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    scenes: [
      {
        ...scene,
        title: 'Shape label insets',
        actions: [],
        content: { ...scene.content, canvas: { ...scene.content.canvas, elements } },
      },
    ],
    outline: {
      outlines: [],
      generationComplete: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  });
  const openEditor = async () => {
    await page.goto(`/classroom/${stageId}`);
    await page
      .getByRole('button', { name: /got it/i })
      .click({ timeout: 3_000 })
      .catch(() => {});
    const toggle = page.getByRole('switch', { name: /edit course/i }).first();
    await expect(toggle).toBeVisible();
    if ((await toggle.getAttribute('aria-checked')) !== 'true') await toggle.click();
    await expect(page.locator('#editable-element-zero .shape-text')).toBeVisible();
  };
  await openEditor();
  for (const label of labels) {
    const wrapper = page.locator(`#editable-element-${label.id} .shape-text`);
    await expect(wrapper).toHaveCSS('padding-left', label.outer);
    if (label.inner !== null) {
      await expect(wrapper.locator('[data-pptx-text-insets="true"]')).toHaveCSS(
        'padding-left',
        label.inner,
      );
    }
  }
  await expect(page.getByTestId('slide-nav-rail').locator('..')).toHaveCSS('opacity', '1');
  await page.screenshot({ path: testInfo.outputPath('legacy-insets.png') });
  await testInfo.attach('legacy-insets', {
    path: testInfo.outputPath('legacy-insets.png'),
    contentType: 'image/png',
  });

  for (const label of labels) {
    const editor = page.locator(`#editable-element-${label.id} .ProseMirror`);
    const originalText = (await editor.textContent())!;
    await page.locator(`#editable-element-${label.id} .shape-path`).dblclick();
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    await editor.press('ControlOrMeta+End');
    await editor.pressSequentially(' edited');
    await expect(editor).toContainText('edited');
    await editor.press('ControlOrMeta+z');
    await expect(editor).not.toContainText('edited');
    await editor.press('ControlOrMeta+y');
    await expect(editor).toContainText('edited');
    await expect(editor).toContainText(originalText);
    await expect
      .poll(async () => {
        const document = await readServerDocument(page, stageId);
        const canvas = (document?.scenes[0].content as { canvas: { elements: typeof elements } })
          .canvas;
        return canvas.elements.find((element) => element.id === label.id)?.text.content;
      })
      .toContain('edited');
  }
  await openEditor();
  for (const label of labels) {
    const wrapper = page.locator(`#editable-element-${label.id} .shape-text`);
    await expect(wrapper).toHaveCSS('padding-left', label.outer);
    await expect(wrapper).toContainText('edited');
    if (label.inner !== null) {
      await expect(wrapper.locator('[data-pptx-text-insets="true"]')).toHaveCSS(
        'padding-left',
        label.inner,
      );
    }
  }
});
