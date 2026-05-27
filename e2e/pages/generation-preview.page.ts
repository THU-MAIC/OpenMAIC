import type { Page, Locator } from '@playwright/test';

export class GenerationPreviewPage {
  readonly page: Page;
  readonly stepTitle: Locator;
  readonly backButton: Locator;
  readonly reviewOutlineButton: Locator;
  readonly editorTitle: Locator;
  readonly alwaysReviewCheckbox: Locator;
  readonly confirmOutlinesButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.stepTitle = page.locator('h2');
    this.backButton = page.getByRole('button', { name: /back|返回/i });
    // The dedicated "Review outline" button was removed in favour of the streaming
    // preview card itself being the entry into the editor. Match its aria-label
    // (`generation.outlineExpandHint`) across all supported locales.
    this.reviewOutlineButton = page.getByRole('button', {
      name: /tap to review|点击审阅|點擊審閱|クリックでレビュー|нажмите, чтобы проверить|اضغط للمراجعة/i,
    });
    this.editorTitle = page.getByRole('heading', {
      name: /scene outline|场景大纲|場景大綱|シーンアウトライン|план сцен|مخطط المشاهد/i,
    });
    this.alwaysReviewCheckbox = page.getByRole('checkbox', {
      name: /always review outlines before generation|以后生成前都审阅大纲|以後生成前都審閱大綱|生成前に常にアウトラインを確認|всегда проверять план|مراجعة المخططات دائمًا/i,
    });
    this.confirmOutlinesButton = page.getByRole('button', {
      name: /confirm and generate course|确认并生成课程|確認並生成課程|確認してコースを生成|подтвердить и сгенерировать курс|تأكيد وتوليد المقرر/i,
    });
  }

  async goto() {
    await this.page.goto('/generation-preview');
  }

  async waitForRedirectToClassroom() {
    await this.page.waitForURL(/\/classroom\//, { timeout: 30_000 });
  }

  async waitForReviewOpportunity() {
    await this.reviewOutlineButton.waitFor({ state: 'visible' });
  }

  async openOutlineReview() {
    await this.reviewOutlineButton.click();
    await this.waitForEditor();
  }

  async waitForEditor() {
    await this.editorTitle.waitFor({ state: 'visible' });
  }

  async enableAlwaysReview() {
    await this.alwaysReviewCheckbox.check();
  }

  async confirmOutlines() {
    await this.confirmOutlinesButton.click();
  }
}
