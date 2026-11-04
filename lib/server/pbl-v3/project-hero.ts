import 'server-only';
import type { ProjectHeroDetails } from '@/lib/pbl/project-hero';
import type { ProjectDefinition } from '@/lib/pbl/v3/domain/project/project-schema';

/** Authored entrance copy only; no generated curriculum or private Skill payload. */
export function projectHeroDetails(project: ProjectDefinition): ProjectHeroDetails {
  const authored = project.presentation?.hero;
  const todo = project.id === 'python-todo-two-milestones';
  const futureSelf = /^future-self(?:-|$)/.test(project.id);
  const greeting = /^greeting-(?:python|java)/.test(project.id);
  const fallback: ProjectHeroDetails = {
    title: project.title,
    description: todo
      ? '用 Python 制作待办清单，先添加任务，再安全删除任务，在两个阶段中逐步完善同一份作品。'
      : futureSelf
        ? '用 Java 逐步构建 Future Self：从对话与记录，到个人成长材料的管理、检索与有依据的回答。和 AI 导师一起完成决策、计划、实现与验证。'
        : greeting
          ? 'Build a greeting application, then extend it while preserving earlier behavior. Work with your AI tutor from decisions and planning to implementation and tests.'
          : 'Work with your AI tutor to plan, implement, test and reflect on this project.',
    gains: todo
      ? [
          '理解 Python 列表与函数返回值',
          '正确添加任务并保留顺序',
          '处理删除任务时的边界情况',
          '结合测试改进代码并复盘',
        ]
      : futureSelf
        ? [
            '用 Java 实现并持续完善一个项目',
            '理解对话、状态和数据持久化',
            '让个人材料参与检索与回答',
            '审阅 AI 产物，用测试验证自己的判断',
          ]
        : greeting
          ? [
              'Connect inputs to returned values',
              'Review a plan and its implementation',
              'Use tests to preserve earlier behavior',
              'Reflect on decisions and corrections',
            ]
          : ['Make project decisions', 'Review plans and code', 'Test and reflect on your work'],
    instructorName: todo || futureSelf ? '项目导师' : 'Project tutor',
    milestoneCount: project.milestones.length,
    taskCount: project.milestones.reduce((count, milestone) => count + milestone.stages.length, 0),
  };
  return authored ? { ...fallback, ...authored } : fallback;
}
