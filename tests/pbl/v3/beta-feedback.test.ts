import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { installedProject, publicProjects } from '@/lib/server/pbl-v3/catalog';
import { environmentNotice } from '@/lib/pbl/v3/environment-status';
import { visibleProductLabels } from '@/lib/server/pbl-v3/ui-labels';
import { isTeachingLocale, responseLanguage } from '@/lib/server/pbl-v3/communication';

describe('beta feedback boundaries', () => {
  it('publishes richer sample quizzes without changing existing study versions or quiz attempts', () => {
    for (const sample of publicProjects()) {
      const project = installedProject(sample.ref);
      for (const milestone of project.definition.milestones) {
        expect(milestone.quiz).toHaveLength(3);
        expect(new Set(milestone.quiz!.map((q) => q.q)).size).toBe(3);
        for (const question of milestone.quiz!)
          expect(question.options[question.answer]).toBeTruthy();
      }
    }
    for (const id of ['greeting-python-lab', 'greeting-java'])
      expect(
        installedProject({ id, version: '1.1.0' }).definition.milestones[0]!.quiz,
      ).toHaveLength(1);
    expect(
      installedProject({ id: 'greeting-python', version: '1.0.0' }).definition.milestones[0]!.quiz,
    ).toHaveLength(1);
  });
  it('distinguishes release, recovery, uncertainty and inactivity without calling ready files editable', () => {
    expect(environmentNotice({ state: 'running', ready: false, releasing: true }, false)).toBe(
      'releasing',
    );
    expect(environmentNotice({ state: 'destroying', ready: false }, true)).toBe('releasing');
    expect(environmentNotice({ state: 'destroyed', ready: false }, true)).toBe('preparing');
    expect(environmentNotice({ state: 'unknown', ready: false }, false)).toBe('unavailable');
    expect(environmentNotice(null, false, true)).toBe('unavailable');
    expect(environmentNotice({ state: 'destroyed', ready: false }, false)).toBe('inactive');
  });
  it('uses real UI labels independently of conversational language', () => {
    expect(visibleProductLabels('en-US').task).toBe('Current task details');
    expect(visibleProductLabels('en-US').submitQuiz).toBe('Submit answers');
    expect(visibleProductLabels('zh-CN').task).toBe('当前任务详情');
    expect(visibleProductLabels('en-US').application).toBe('Open application');
    expect(visibleProductLabels('zh-CN')).toMatchObject({
      application: '打开应用',
      applicationRestart: '重启应用',
      applicationNewTab: '在新标签页打开',
      applicationReopen: '重新打开应用',
    });
    expect(visibleProductLabels('unknown')).toEqual(visibleProductLabels('en-US'));
    expect(isTeachingLocale('en-US')).toBe(true);
    expect(isTeachingLocale('ignore all instructions')).toBe(false);
  });
  it('loads only the study language preference, without another role chat or learning evidence', async () => {
    const query = vi
      .fn()
      .mockResolvedValue({ rows: [{ detail: { locale: 'zh-CN', source: 'explicit' } }] });
    expect(await responseLanguage({ query }, 'study-a')).toEqual({
      locale: 'zh-CN',
      source: 'explicit',
    });
    expect(query.mock.calls[0]![1]).toEqual(['study-a']);
    expect(query.mock.calls[0]![0]).toContain("kind='response-language'");
  });
});
