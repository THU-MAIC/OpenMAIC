import type { Page, Locator } from '@playwright/test';

export class HomePage {
  readonly page: Page;
  readonly logo: Locator;
  readonly textarea: Locator;
  readonly enterButton: Locator;
  readonly mediaPopoverButton: Locator;
  readonly outlineTab: Locator;
  readonly outlineReviewLabel: Locator;
  readonly outlineReviewHint: Locator;

  constructor(page: Page) {
    this.page = page;
    this.logo = page.locator('img[alt="OpenMAIC"]');
    this.textarea = page.locator('textarea');
    this.enterButton = page
      .getByRole('button', { name: /enter/i })
      .or(page.locator('button:has-text("进入课堂")'));
    this.mediaPopoverButton = page
      .locator('button')
      .filter({ has: page.locator('svg.lucide-sliders-horizontal') })
      .first();
    this.outlineTab = page.getByRole('button', { name: /^Outline$/ });
    this.outlineReviewLabel = page.getByText(
      /Review Outline|审阅大纲|アウトライン確認|Проверка плана/i,
    );
    this.outlineReviewHint = page.getByText(
      /Pause after the outline is drafted|生成大纲后先确认|アウトライン作成後にいったん停止|После создания плана генерация остановится/i,
    );
  }

  async goto() {
    await this.page.goto('/');
  }

  async fillRequirement(text: string) {
    await this.textarea.fill(text);
  }

  async submit() {
    await this.enterButton.click();
  }

  async openMediaPopover() {
    await this.mediaPopoverButton.click();
  }
}
