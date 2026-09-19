import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en-US' }),
}));

vi.mock('@/components/scene-renderers/pbl/v2/workspace', async () => {
  const { createElement } = await import('react');
  return {
    PBLV2Workspace: ({ project }: { project: { title: string } }) =>
      createElement('div', { 'data-testid': 'pbl-v2-workspace' }, project.title),
  };
});

vi.mock('@/components/scene-renderers/pbl/v2/hero', async () => {
  const { createElement } = await import('react');
  return {
    PBLV2Hero: ({ project }: { project: { title: string } }) =>
      createElement('div', { 'data-testid': 'pbl-v2-hero' }, project.title),
  };
});

import { PBLRenderer } from '@/components/scene-renderers/pbl-renderer';
import { validateAppScene } from '@/lib/document-store/validators';
import {
  isEmptyLegacyPBLConfig,
  normalizeLegacyPBLContent,
  resolvePBLContent,
  upgradeLegacyPBLConfigToProjectV2,
} from '@/lib/pbl/legacy/read';
import { isPBLProjectV2, type PBLProjectV2 } from '@/lib/pbl/v2/types';
import { legacyPBLSceneFixture } from '@/tests/fixtures/pbl-v1-scene';

function legacyConfig() {
  const content = structuredClone(legacyPBLSceneFixture.content);
  if (content.type !== 'pbl' || !content.projectConfig) {
    throw new Error('expected legacy PBL projectConfig');
  }
  return content.projectConfig;
}

function titleOnlyLegacyConfig() {
  const config = legacyConfig();
  config.agents = [];
  config.issueboard.issues = [];
  config.issueboard.current_issue_id = null;
  config.chat.messages = [];
  config.selectedRole = null;
  return config;
}

const nonRunnableV2Mutations: Array<[string, (project: PBLProjectV2) => void]> = [
  [
    'all milestones have empty microtasks',
    (project) => {
      project.milestones.forEach((milestone) => {
        milestone.microtasks = [];
      });
    },
  ],
  [
    'one milestone has no microtasks',
    (project) => {
      project.milestones.at(-1)!.microtasks = [];
    },
  ],
  [
    'there is no Instructor role',
    (project) => {
      project.roles.forEach((role) => {
        role.type = 'mentor';
      });
    },
  ],
  [
    'the Instructor has no id',
    (project) => {
      Reflect.deleteProperty(project.roles.find((role) => role.type === 'instructor')!, 'id');
    },
  ],
  [
    'the Instructor has no name',
    (project) => {
      Reflect.deleteProperty(project.roles.find((role) => role.type === 'instructor')!, 'name');
    },
  ],
  [
    'a microtask has no id',
    (project) => {
      Reflect.deleteProperty(project.milestones.at(-1)!.microtasks.at(-1)!, 'id');
    },
  ],
  [
    'a microtask has no title',
    (project) => {
      Reflect.deleteProperty(project.milestones.at(-1)!.microtasks.at(-1)!, 'title');
    },
  ],
];

describe('PBL legacy read support', () => {
  it('resolves valid v2 content ahead of a usable legacy fallback', () => {
    const projectConfig = legacyConfig();
    const projectV2 = upgradeLegacyPBLConfigToProjectV2(projectConfig);

    expect(resolvePBLContent({ projectV2, projectConfig })).toEqual({
      kind: 'v2',
      projectV2,
    });
  });

  it('resolves usable legacy content ahead of a container-valid v2 project with no milestones', () => {
    const projectConfig = legacyConfig();
    const projectV2 = upgradeLegacyPBLConfigToProjectV2(projectConfig);
    projectV2.milestones = [];

    expect(resolvePBLContent({ projectV2, projectConfig })).toEqual({
      kind: 'legacy',
      projectConfig,
    });
  });

  it.each([
    ['missing', {}],
    ['undefined', { projectV2: undefined }],
    ['null', { projectV2: null }],
    ['damaged', { projectV2: { title: 'broken' } }],
  ])('resolves usable legacy content when projectV2 is %s', (_label, v2Content) => {
    const projectConfig = legacyConfig();

    expect(resolvePBLContent({ ...v2Content, projectConfig })).toEqual({
      kind: 'legacy',
      projectConfig,
    });
  });

  it.each([
    ['missing content', {}],
    ['null values', { projectV2: null, projectConfig: null }],
    ['damaged v2', { projectV2: { title: 'broken' } }],
    ['malformed legacy', { projectConfig: {} }],
    ['title-only legacy', { projectConfig: titleOnlyLegacyConfig() }],
    [
      'empty legacy',
      {
        projectConfig: {
          projectInfo: { title: '', description: '' },
          agents: [],
          issueboard: { agent_ids: [], issues: [], current_issue_id: null },
          chat: { messages: [] },
        },
      },
    ],
  ])('resolves %s as empty', (_label, content) => {
    expect(resolvePBLContent(content)).toEqual({ kind: 'empty' });
  });

  it('normalizes a damaged hybrid from its usable legacy project', () => {
    const content = structuredClone(legacyPBLSceneFixture.content);
    if (content.type !== 'pbl') throw new Error('expected legacy PBL content');
    Reflect.set(content, 'projectV2', { title: 'broken' });

    const normalized = normalizeLegacyPBLContent(content);

    expect(normalized).toMatchObject({
      type: 'pbl',
      projectV2: {
        title: 'Community Garden Data Project',
        milestones: [{ title: 'Inspect the measurements' }, { title: 'Recommend a watering plan' }],
      },
    });
  });

  it('leaves title-only legacy content unnormalized for the existing empty-content path', () => {
    const content = { type: 'pbl' as const, projectConfig: titleOnlyLegacyConfig() };

    expect(normalizeLegacyPBLContent(content)).toBe(content);
  });

  it('round-trips a v1-native stored scene and upgrades it to a renderable v2 project', () => {
    const roundTripped = JSON.parse(JSON.stringify(legacyPBLSceneFixture));
    expect(validateAppScene(roundTripped)).toEqual({ valid: true });
    if (roundTripped.content.type !== 'pbl' || !roundTripped.content.projectConfig) {
      throw new Error('expected a legacy PBL projectConfig');
    }

    const project = upgradeLegacyPBLConfigToProjectV2(roundTripped.content.projectConfig);
    expect(isPBLProjectV2(project)).toBe(true);
    expect(project).toMatchObject({
      uiPhase: 'workspace',
      title: 'Community Garden Data Project',
      language: 'en-US',
      milestones: [{ status: 'completed' }, { status: 'active' }],
    });
    expect(project.roles[0]).toMatchObject({ type: 'instructor', name: 'Question Agent' });
    expect(project.milestones[1].microtasks[0].status).toBe('in_progress');
    expect(project.threads[0]?.messages.map((message) => message.roleType)).toEqual([
      'instructor',
      'user',
    ]);
  });

  it('routes a v1-native stored scene through the v2 renderer', () => {
    const content = structuredClone(legacyPBLSceneFixture.content);
    if (content.type !== 'pbl') throw new Error('expected PBL fixture content');
    if (!content.projectConfig) throw new Error('expected legacy PBL projectConfig');
    content.projectConfig.selectedRole = null;
    content.projectConfig.chat.messages = [];
    content.projectConfig.issueboard.current_issue_id = 'issue-1';
    content.projectConfig.issueboard.issues.forEach((issue, index) => {
      issue.is_done = false;
      issue.is_active = index === 0;
    });
    const markup = renderToStaticMarkup(
      createElement(PBLRenderer, {
        content,
        mode: 'playback',
        sceneId: legacyPBLSceneFixture.id,
      }),
    );

    expect(markup).toContain('data-testid="pbl-v2-hero"');
    expect(markup).toContain('Community Garden Data Project');
  });

  it('falls back to upgraded legacy data when a hybrid scene has malformed projectV2', () => {
    const content = structuredClone(legacyPBLSceneFixture.content);
    if (content.type !== 'pbl' || !content.projectConfig) {
      throw new Error('expected legacy PBL projectConfig');
    }
    content.projectConfig.selectedRole = null;
    content.projectConfig.chat.messages = [];
    content.projectConfig.issueboard.current_issue_id = 'issue-1';
    content.projectConfig.issueboard.issues.forEach((issue, index) => {
      issue.is_done = false;
      issue.is_active = index === 0;
    });
    Reflect.set(content, 'projectV2', { title: 'broken' });

    const markup = renderToStaticMarkup(
      createElement(PBLRenderer, {
        content,
        mode: 'playback',
        sceneId: legacyPBLSceneFixture.id,
      }),
    );

    expect(markup).toContain('data-testid="pbl-v2-hero"');
    expect(markup).toContain('Community Garden Data Project');
    expect(markup).not.toContain('pbl.emptyProject');
  });

  it('renders upgraded legacy data when a hybrid v2 project has no milestones', () => {
    const content = structuredClone(legacyPBLSceneFixture.content);
    if (content.type !== 'pbl' || !content.projectConfig) {
      throw new Error('expected legacy PBL projectConfig');
    }
    const projectV2 = upgradeLegacyPBLConfigToProjectV2(content.projectConfig);
    projectV2.title = 'Empty v2 title';
    projectV2.milestones = [];
    content.projectV2 = projectV2;
    content.projectConfig.selectedRole = null;
    content.projectConfig.chat.messages = [];
    content.projectConfig.issueboard.current_issue_id = 'issue-1';
    content.projectConfig.issueboard.issues.forEach((issue, index) => {
      issue.is_done = false;
      issue.is_active = index === 0;
    });

    const markup = renderToStaticMarkup(
      createElement(PBLRenderer, {
        content,
        mode: 'playback',
        sceneId: legacyPBLSceneFixture.id,
      }),
    );

    expect(markup).toContain('data-testid="pbl-v2-hero"');
    expect(markup).toContain('Community Garden Data Project');
    expect(markup).not.toContain('Empty v2 title');
  });

  it.each(nonRunnableV2Mutations)(
    'renders upgraded legacy data when %s',
    (_label, makeNonRunnable) => {
      const content = structuredClone(legacyPBLSceneFixture.content);
      if (content.type !== 'pbl' || !content.projectConfig) {
        throw new Error('expected legacy PBL projectConfig');
      }
      const projectV2 = upgradeLegacyPBLConfigToProjectV2(content.projectConfig);
      projectV2.title = 'Non-runnable v2 title';
      makeNonRunnable(projectV2);
      content.projectV2 = projectV2;
      content.projectConfig.selectedRole = null;
      content.projectConfig.chat.messages = [];
      content.projectConfig.issueboard.current_issue_id = 'issue-1';
      content.projectConfig.issueboard.issues.forEach((issue, index) => {
        issue.is_done = false;
        issue.is_active = index === 0;
      });

      expect(resolvePBLContent(content)).toEqual({
        kind: 'legacy',
        projectConfig: content.projectConfig,
      });

      const markup = renderToStaticMarkup(
        createElement(PBLRenderer, {
          content,
          mode: 'playback',
          sceneId: legacyPBLSceneFixture.id,
        }),
      );

      expect(markup).toContain('data-testid="pbl-v2-hero"');
      expect(markup).toContain('Community Garden Data Project');
      expect(markup).not.toContain('Non-runnable v2 title');
    },
  );

  it('detects Chinese content when upgrading a legacy project', () => {
    const config = legacyConfig();
    config.projectInfo.title = '天气数据项目';
    config.projectInfo.description = '分析天气数据并完成展示。';
    config.issueboard.issues[0].title = '读取数据';

    const project = upgradeLegacyPBLConfigToProjectV2(config);

    expect(project.language).toBe('zh-CN');
  });

  it('uses current_issue_id when legacy is_active is missing', () => {
    const config = legacyConfig();
    config.issueboard.issues.forEach((issue) => {
      issue.is_done = false;
      issue.is_active = false;
    });
    config.issueboard.current_issue_id = 'issue-2';

    const project = upgradeLegacyPBLConfigToProjectV2(config);

    expect(project.milestones.map((milestone) => milestone.status)).toEqual(['locked', 'active']);
  });

  it('keeps structurally sound legacy configs with sloppy leaves renderable', () => {
    const config = legacyConfig();
    const issue = config.issueboard.issues[0];
    const message = config.chat.messages[0];
    Reflect.deleteProperty(issue, 'notes');
    Reflect.deleteProperty(issue, 'generated_questions');
    Reflect.deleteProperty(issue, 'question_agent_name');
    Reflect.deleteProperty(message, 'timestamp');

    expect(isEmptyLegacyPBLConfig(config)).toBe(false);

    const project = upgradeLegacyPBLConfigToProjectV2(config);
    expect(isPBLProjectV2(project)).toBe(true);
    expect(project.title).toBe('Community Garden Data Project');
    expect(project.milestones[0]).toMatchObject({
      id: 'legacy_ms_issue-1',
      title: 'Inspect the measurements',
    });
    expect(project.threads[0]?.messages[0]?.ts).toEqual(expect.any(String));
  });

  it('drops malformed legacy chat records without classifying the config as empty', () => {
    const config = legacyConfig();
    const validMessage = config.chat.messages[0];
    const missingMessage = structuredClone(config.chat.messages[1]);
    const nonStringMessage = structuredClone(config.chat.messages[1]);
    Reflect.deleteProperty(missingMessage, 'message');
    Reflect.set(nonStringMessage, 'message', 42);
    config.chat.messages = [validMessage, missingMessage, nonStringMessage];

    expect(isEmptyLegacyPBLConfig(config)).toBe(false);

    const project = upgradeLegacyPBLConfigToProjectV2(config);
    expect(project.threads[0]?.messages).toHaveLength(1);
    expect(project.threads[0]?.messages[0]?.content).toBe(validMessage.message);
  });

  it('falls back to a valid ISO timestamp for an unparseable legacy timestamp', () => {
    const config = legacyConfig();
    Reflect.set(config.chat.messages[0], 'timestamp', 'not-a-date');

    const project = upgradeLegacyPBLConfigToProjectV2(config);
    const timestamp = project.threads[0]?.messages[0]?.ts;

    expect(() => new Date(timestamp ?? '').toISOString()).not.toThrow();
    expect(timestamp).toBe(new Date(timestamp ?? '').toISOString());
  });

  it('renders emptyProject for a new empty PBL scene', () => {
    const markup = renderToStaticMarkup(
      createElement(PBLRenderer, {
        content: { type: 'pbl' },
        mode: 'playback',
        sceneId: 'new-pbl-scene',
      }),
    );

    expect(markup).toContain('pbl.emptyProject');
  });

  it('renders a placeholder for a v2-only project with no milestones', () => {
    const projectV2 = upgradeLegacyPBLConfigToProjectV2(legacyConfig());
    projectV2.milestones = [];
    const markup = renderToStaticMarkup(
      createElement(PBLRenderer, {
        content: { type: 'pbl', projectV2 },
        mode: 'playback',
        sceneId: 'empty-v2-pbl-scene',
      }),
    );

    expect(markup).toContain('pbl.emptyProject');
  });

  it.each(nonRunnableV2Mutations)(
    'renders a placeholder for a v2-only project when %s',
    (_label, makeNonRunnable) => {
      const projectV2 = upgradeLegacyPBLConfigToProjectV2(legacyConfig());
      makeNonRunnable(projectV2);

      const markup = renderToStaticMarkup(
        createElement(PBLRenderer, {
          content: { type: 'pbl', projectV2 },
          mode: 'playback',
          sceneId: 'non-runnable-v2-pbl-scene',
        }),
      );

      expect(markup).toContain('pbl.emptyProject');
    },
  );

  it('renders a placeholder for a damaged hybrid whose legacy shell has no issues', () => {
    const markup = renderToStaticMarkup(
      createElement(PBLRenderer, {
        content: {
          type: 'pbl',
          projectConfig: titleOnlyLegacyConfig(),
          projectV2: { title: 'broken' },
        } as never,
        mode: 'playback',
        sceneId: 'unrunnable-hybrid-pbl-scene',
      }),
    );

    expect(markup).toContain('pbl.emptyProject');
  });

  it('renders a placeholder for an unusable legacy projectConfig without throwing', () => {
    const markup = renderToStaticMarkup(
      createElement(PBLRenderer, {
        content: { type: 'pbl', projectConfig: {} } as never,
        mode: 'playback',
        sceneId: 'garbage-legacy-pbl-scene',
      }),
    );

    expect(markup).toContain('pbl.emptyProject');
  });

  it('renders a placeholder for malformed stored projectV2 without throwing', () => {
    const markup = renderToStaticMarkup(
      createElement(PBLRenderer, {
        content: { type: 'pbl', projectV2: { title: 'V2 project' } } as never,
        mode: 'playback',
        sceneId: 'malformed-v2-pbl-scene',
      }),
    );

    expect(markup).toContain('pbl.emptyProject');
  });
});
