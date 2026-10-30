import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { projectHeroDetails } from '@/lib/server/pbl-v3/project-hero';
import { installedProject } from '@/lib/server/pbl-v3/catalog';

describe('authored project entrances', () => {
  const sample = installedProject({ id: 'greeting-python-lab', version: '1.1.0' }).definition;
  it('uses optional public presentation without overriding authoritative title or counts', () => {
    const definition = structuredClone(sample);
    definition.presentation = {
      hero: {
        description: 'Authored project introduction',
        gains: ['Review your own choices'],
        instructorName: 'Learning guide',
      },
    };
    expect(projectHeroDetails(definition)).toMatchObject({
      title: definition.title,
      ...definition.presentation.hero,
      milestoneCount: 2,
      taskCount: 14,
    });
    const old = structuredClone(sample);
    expect(projectHeroDetails(old)).toEqual(
      projectHeroDetails({ ...old, presentation: undefined }),
    );
  });
  it.each(['python-todo-two-milestones', 'future-self', 'greeting-python-lab', 'greeting-java'])(
    'uses public authored copy and actual stage counts for %s',
    (id) => {
      const definition = structuredClone(sample);
      definition.id = id;
      definition.title = 'Public project title';
      definition.intro.say = 'PRIVATE TEACHING INSTRUCTION';
      definition.milestones[0]!.contract = 'PRIVATE CONTRACT';
      const hero = projectHeroDetails(definition);
      expect(hero).toMatchObject({
        title: 'Public project title',
        milestoneCount: 2,
        taskCount: 14,
      });
      expect(hero.description).toBeTruthy();
      expect(hero.gains!.length).toBeGreaterThan(0);
      expect(hero.instructorName).toBeTruthy();
      expect(JSON.stringify(hero)).not.toContain('PRIVATE');
    },
  );
});
