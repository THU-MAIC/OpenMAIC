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
    const flow = page.getByTestId('creation-flow-learning');
    await expect(flow).toBeVisible();
    await expect(flow.getByText('让每次学习留下成果')).toBeVisible();
    await page.getByPlaceholder('例如：数据结构').fill('数据结构');
    await page.getByPlaceholder('例如：二叉树遍历').fill('二叉树遍历');
    await page.getByPlaceholder('例如：能区分并手写三种遍历过程').fill('区分三种遍历过程');
    await page.getByPlaceholder('例如：了解递归和栈').fill('了解递归');

    const requirement = page.getByTestId('course-requirement-input');
    await expect(requirement).toHaveValue(/核心知识点：二叉树遍历/);
    await expect(page.getByTestId('course-generate-submit')).toBeEnabled();
    await expect(page.getByTestId('nav-learning-task')).toHaveAttribute('aria-current', 'page');
    await expect(flow.getByText('3 / 3 项必填已完成')).toBeVisible();
  });

  test('shows durable learning tasks separately from the course library', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        'zhigou.learning.tasks.v1',
        JSON.stringify([
          {
            schemaVersion: 1,
            id: 'task-active',
            template: 'concept-understanding',
            courseName: '操作系统',
            knowledgePoint: '进程与线程',
            learningGoal: '理解两者的区别',
            priorKnowledge: '计算机基础',
            status: 'ready',
            classroomId: 'classroom-demo',
            visitedSceneIds: ['scene-1'],
            reviewSceneIds: ['scene-1'],
            notes: {
              'scene-1': { sceneId: 'scene-1', content: '线程共享进程资源', updatedAt: 2 },
            },
            createdAt: 2,
            updatedAt: 2,
          },
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

    await center.getByTestId('task-filter-review').click();
    await expect(center.getByTestId('learning-task-filter-heading')).toHaveText(
      /待复习任务\s*·\s*1/,
    );
    await expect(center.getByText('进程与线程', { exact: true })).toBeVisible();
    await expect(center.getByText('极限', { exact: true })).toHaveCount(0);

    await center.getByTestId('task-filter-notes').click();
    await expect(center.getByTestId('learning-task-filter-heading')).toHaveText(
      /包含笔记的任务\s*·\s*1/,
    );
    await expect(center.getByText('进程与线程', { exact: true })).toBeVisible();

    await center.getByRole('button', { name: '查看全部' }).click();
    await expect(center.getByText('极限', { exact: true })).toBeVisible();
  });
});
