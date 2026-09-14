import { expect, test } from '../fixtures/base';
import { createSettingsStorage } from '../fixtures/test-data/settings';

const SETTINGS_STORAGE = createSettingsStorage();

test.describe('ZhiGou learning loop', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((settings) => {
      localStorage.setItem('maic:account:settings-storage', settings);
      localStorage.setItem('locale', 'zh-CN');
    }, SETTINGS_STORAGE);
  });

  test('creates a goal-based generation brief from structured fields', async ({ page }) => {
    await page.goto('/learn/new');

    await expect(page.getByTestId('learning-task-fields')).toBeVisible();
    await page.getByPlaceholder('例如：数据结构').fill('数据结构');
    await page.getByPlaceholder('例如：二叉树遍历').fill('二叉树遍历');
    await page.getByPlaceholder('例如：能区分并手写三种遍历过程').fill('区分三种遍历过程');
    await page.getByPlaceholder('例如：了解递归和栈').fill('了解递归');

    const requirement = page.getByTestId('course-requirement-input');
    await expect(requirement).toHaveValue(/核心知识点：二叉树遍历/);
    await expect(page.getByTestId('course-generate-submit')).toBeEnabled();
    await expect(page.getByTestId('nav-learning-task')).toHaveAttribute('aria-current', 'page');
  });

  test('shows durable learning tasks separately from the course library', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        'zhigou.learning.tasks.v1',
        JSON.stringify([
          {
            schemaVersion: 1,
            id: 'task-demo',
            template: 'concept-understanding',
            courseName: '高等数学',
            knowledgePoint: '极限',
            learningGoal: '理解极限的直观含义',
            priorKnowledge: '函数基础',
            status: 'draft',
            visitedSceneIds: [],
            reviewSceneIds: [],
            notes: {},
            createdAt: 1,
            updatedAt: 1,
          },
        ]),
      );
    });
    await page.goto('/');

    const center = page.getByTestId('learning-task-center');
    await expect(center).toBeVisible();
    await expect(center.getByText('极限', { exact: true })).toBeVisible();
    await expect(center.getByText('继续创建')).toBeVisible();
  });
});
