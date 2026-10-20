import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';

// A component browser regression: no Next server, database or model is used.
// The existing E2E CI job discovers this spec and installs Chromium.
let bundle: string;
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [path.resolve('e2e/fixtures/material-library-focus-handover.tsx')],
    bundle: true,
    write: false,
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [
      {
        name: 'library-browser-boundaries',
        setup(builder) {
          builder.onLoad({ filter: /\/lib\/hooks\/use-i18n\.tsx?$/ }, () => ({
            contents: `export const useI18n = () => ({ locale: 'en-US', t: key => key });`,
            loader: 'js',
          }));
          builder.onLoad({ filter: /\/lib\/workbench\/session-store\.ts$/ }, () => ({
            contents: `export const useWorkbenchStore = fn => fn({ materialLibraryRevision: 0 });
              export const uploadWorkbenchMaterial = () => {};
              export class WorkbenchMaterialUploadError extends Error {}`,
            loader: 'js',
          }));
          builder.onLoad({ filter: /\/lib\/workbench\/agent-skills\.ts$/ }, () => ({
            contents: `export const useAgentSkills = () => ({ skills: [] });
              export const skillLabelForId = id => id;
              export const skillTitle = () => undefined;`,
            loader: 'js',
          }));
        },
      },
    ],
  });
  bundle = result.outputFiles[0].text;
});

for (const entry of [
  'upload-link',
  'tool-link-f1',
  'tool-link-top',
  'tool-link-gone',
  'stale-upload-link',
]) {
  for (const activation of ['click', 'keyboard']) {
    test(`${entry}/${activation}: hands focus to the library after loading`, async ({ page }) => {
      const reads: string[] = [];
      await page.route('http://library.test/**', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
      );
      await page.route('**/api/materials/**', async (route) => {
        const url = new URL(route.request().url());
        reads.push(url.pathname + url.search);
        // Keep the real initial loading render, including its effect ordering.
        await new Promise((resolve) => setTimeout(resolve, 50));
        await route.fulfill({
          json: url.pathname.endsWith('/folders')
            ? { folders: [{ id: 'f1', name: 'Folder 1', materialCount: 0 }] }
            : {
                materials:
                  url.searchParams.get('folderId') === 'f1'
                    ? []
                    : [
                        {
                          materialId: 'm1',
                          name: 'm1.pdf',
                          mime: 'application/pdf',
                          bytes: 128,
                          folderId: null,
                          extraction: { status: 'pending' },
                          createdAt: '2026-10-16T00:00:00Z',
                        },
                      ],
              },
        });
      });
      await page.goto('http://library.test');
      await page.addScriptTag({ content: bundle });
      const source = page.getByTestId(entry);
      const opener = entry.startsWith('tool-link-')
        ? source.getByTestId('workbench-tool-library-link')
        : source.getByRole('button');
      if (activation === 'keyboard') {
        await opener.focus();
        await opener.press('Enter');
      } else {
        await opener.click();
      }
      await expect(page.getByTestId('source-composer')).toBeHidden();
      await expect(page.getByTestId('kb-folder-toggle-f1')).toBeVisible();
      if (entry === 'tool-link-f1') {
        await expect(page.getByTestId('kb-folder-toggle-f1')).toHaveAttribute(
          'aria-expanded',
          'true',
        );
        await expect(page.getByTestId('kb-folder-toggle-f1')).toBeFocused();
      } else if (entry === 'tool-link-gone') {
        await expect(page.getByTestId('kb-focus-notice')).toHaveText(
          'workspace.knowledgeBase.focus.folderUnavailable',
        );
      } else {
        await expect(page.getByTestId('kb-material-menu-m1')).toBeFocused();
        if (entry === 'stale-upload-link') {
          await expect(page.getByTestId('kb-focus-notice')).toHaveText(
            'workspace.knowledgeBase.focus.materialsUnavailable',
          );
          expect(reads).toHaveLength(2);
        } else {
          await expect(page.getByTestId('kb-focus-notice')).toHaveCount(0);
        }
      }
      await page.getByTestId('kb-back').click();
      await expect(page.getByLabel('Draft')).toHaveValue('Keep this draft');
    });
  }
}
