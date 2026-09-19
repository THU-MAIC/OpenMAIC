// @vitest-environment jsdom

/**
 * The client-side skill registry's display rule: display name + the English id,
 * everywhere, with the id never dropped. A built-in skill's name comes from the
 * locale copy map (`workbench.skill.title.<handle>`); a user Skill's comes from
 * the registry, because its author named it.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  invalidateAgentSkills,
  refreshAgentSkillsForOwnerChange,
  skillDisplayLabel,
  skillLabelForId,
} from '@/lib/workbench/agent-skills';
import { createWorkbenchTranslator } from '@/lib/i18n/workbench';

const skill = (id: string, title?: string) => ({
  id,
  name: id,
  ...(title ? { title } : {}),
  description: `${id} description`,
  hasConstraints: false,
  source: 'builtin' as const,
});

describe('skill display labels', () => {
  it('names a built-in skill from the copy map, in this locale, AND by its id', () => {
    expect(skillDisplayLabel(skill('stage-design'))).toBe('课堂设计 /stage-design');
    expect(skillDisplayLabel(skill('stage-design'), createWorkbenchTranslator('en-US'))).toBe(
      'Classroom design /stage-design',
    );
  });

  it('lets the registry name a skill the copy map has never heard of', () => {
    // A user Skill (named by its author) and a built-in one whose copy has not
    // landed yet take the same path: the frontmatter/registry title.
    expect(skillDisplayLabel({ name: 'my-way', title: '我的做课法', source: 'user' })).toBe(
      '我的做课法 /my-way',
    );
    expect(skillDisplayLabel(skill('brand-new-skill', '全新技能'))).toBe(
      '全新技能 /brand-new-skill',
    );
  });

  it('falls back to the bare id rather than showing an empty name', () => {
    expect(skillDisplayLabel({ name: 'my-way', source: 'user' })).toBe('/my-way');
    expect(skillDisplayLabel({ name: 'my-way', title: '   ', source: 'user' })).toBe('/my-way');
    expect(skillDisplayLabel({ name: 'my-way', title: null, source: 'user' })).toBe('/my-way');
  });

  it('resolves an id against the installed list, and names a built-in id on its own', () => {
    const installed = [skill('stage-design', '课堂设计'), skill('pptx-import', 'PPT 导入')];
    // The timeline's case: a transcript records the id only.
    expect(skillLabelForId('pptx-import', installed)).toBe('PPT 导入 /pptx-import');
    // A skill that is no longer installed: the row still says which one was read.
    expect(skillLabelForId('retired-skill', installed)).toBe('/retired-skill');
    // A registry that has not loaded yet still names a BUILT-IN skill, because
    // its display copy does not come from the registry.
    expect(skillLabelForId('pptx-import', [])).toBe('PPT 导入 /pptx-import');
  });
});

describe('skill registry invalidation', () => {
  it('coalesces simultaneous consumers into one refresh request', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 'usk_1',
              name: 'my-demo',
              title: '我的 Skill',
              description: 'demo',
              hasConstraints: false,
              source: 'user',
            },
          ]),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    await invalidateAgentSkills();
    const [a, b] = await Promise.all([invalidateAgentSkills(), invalidateAgentSkills()]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(a).toEqual(b);
    expect(a[0]).toMatchObject({ id: 'usk_1', name: 'my-demo', source: 'user' });
    vi.unstubAllGlobals();
  });

  it('drops owner-scoped metadata before refreshing after an auth change', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: 'usk_new',
            name: 'my-new-owner',
            title: '新账号 Skill',
            description: 'new owner',
            hasConstraints: false,
            source: 'user',
          },
        ]),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(refreshAgentSkillsForOwnerChange()).resolves.toMatchObject([
      { id: 'usk_new', name: 'my-new-owner' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
