import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { StatelessChatRequest } from '@/lib/types/chat';
import type { WhiteboardActionRecord, AgentTurnSummary } from '@/lib/orchestration/types';

export const teacherAgent: AgentConfig = {
  id: 'teacher_1',
  name: 'Mr. Chen',
  role: 'teacher',
  persona: 'A patient high-school physics teacher.',
  priority: 100,
  allowedActions: [
    'spotlight',
    'laser',
    'wb_open',
    'wb_draw_text',
    'wb_draw_shape',
    'wb_draw_chart',
    'wb_draw_latex',
    'wb_draw_table',
    'wb_draw_line',
    'wb_draw_code',
    'wb_edit_code',
    'wb_clear',
    'wb_delete',
    'wb_close',
  ],
  avatar: '',
  color: '#000',
  createdAt: new Date(0),
  updatedAt: new Date(0),
  isDefault: true,
};

export const studentAgent: AgentConfig = {
  ...teacherAgent,
  id: 'student_1',
  name: 'Lily',
  role: 'student',
  priority: 50,
  persona: 'A curious 9th grader who likes asking why.',
};

export const assistantAgent: AgentConfig = {
  ...teacherAgent,
  id: 'assistant_1',
  name: 'Aria',
  role: 'assistant',
  priority: 75,
  persona: 'A supportive TA who fills in gaps.',
};

export const slideStoreState: StatelessChatRequest['storeState'] = {
  stage: {
    id: 'stage-1',
    name: 'Physics: Force Decomposition',
    languageDirective: '中文 (zh-CN)',
    createdAt: 0,
    updatedAt: 0,
  },
  scenes: [
    {
      id: 'scene-1',
      stageId: 'stage-1',
      type: 'slide',
      title: '力的分解',
      order: 0,
      content: {
        type: 'slide',
        canvas: {
          id: 'c1',
          viewportSize: 1000,
          viewportRatio: 0.5625,
          theme: {
            backgroundColor: '#fff',
            themeColors: [],
            fontColor: '#333',
            fontName: 'YaHei',
          },
          elements: [
            {
              type: 'text',
              id: 'title-1',
              content: '<p>力的分解</p>',
              left: 60,
              top: 40,
              width: 880,
              height: 70,
              rotate: 0,
              defaultFontName: 'YaHei',
              defaultColor: '#333',
            },
          ],
        },
      },
    },
  ],
  currentSceneId: 'scene-1',
  mode: 'autonomous',
  whiteboardOpen: false,
};

export const quizStoreState: StatelessChatRequest['storeState'] = {
  ...slideStoreState,
  scenes: [
    {
      id: 'scene-quiz',
      stageId: 'stage-1',
      type: 'quiz',
      title: '测验：力的分解',
      order: 0,
      content: {
        type: 'quiz',
        questions: [
          {
            id: 'q1',
            type: 'single',
            question: '斜面上的物体受到哪几个力？',
            options: [
              { label: '重力和支持力', value: 'A' },
              { label: '重力、支持力和摩擦力', value: 'B' },
            ],
            answer: ['B'],
          },
        ],
      },
    },
  ],
  currentSceneId: 'scene-quiz',
};

export const whiteboardLedger: WhiteboardActionRecord[] = [
  {
    actionName: 'wb_draw_text',
    agentId: 'teacher_1',
    agentName: 'Mr. Chen',
    params: { content: '步骤 1: 受力分析', x: 100, y: 100, width: 400, height: 80 },
  },
];

export const peerResponses: AgentTurnSummary[] = [
  {
    agentId: 'teacher_1',
    agentName: 'Mr. Chen',
    contentPreview: '我们先看 G 沿斜面方向的分量',
    actionCount: 2,
    whiteboardActions: [],
  },
];
