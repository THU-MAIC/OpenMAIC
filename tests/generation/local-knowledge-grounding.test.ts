import { describe, expect, it } from 'vitest';
import { generateSceneActions, generateSceneContent } from '@/lib/generation/scene-generator';
import type { AICallFn } from '@/lib/generation/pipeline-types';
import type { GeneratedSlideContent, SceneOutline } from '@/lib/types/generation';

describe('local knowledge grounding in content generation', () => {
  it('threads retrieved excerpts into slide generation prompts', async () => {
    let capturedPrompt = '';
    const aiCall: AICallFn = async (_system, user) => {
      capturedPrompt = user;
      return JSON.stringify({ elements: [], background: null, remark: '' });
    };
    const outline: SceneOutline = {
      id: 'scene-1',
      type: 'slide',
      title: 'U660E 阀体诊断',
      description: '讲解检查流程',
      keyPoints: ['检查油压'],
      order: 1,
    };
    const groundingContext = '[Source: U660E.pdf]\n阀体油压测试前需连接指定压力表。';

    await generateSceneContent(outline, aiCall, { groundingContext });

    expect(capturedPrompt).toContain('Retrieved Reference Material');
    expect(capturedPrompt).toContain(groundingContext);
    expect(capturedPrompt).not.toContain('{{groundingContext}}');
  });

  it('threads retrieved excerpts into teacher action prompts', async () => {
    let capturedPrompt = '';
    const aiCall: AICallFn = async (_system, user) => {
      capturedPrompt = user;
      return JSON.stringify([{ type: 'text', content: '请先确认压力表连接可靠。' }]);
    };
    const outline: SceneOutline = {
      id: 'scene-2',
      type: 'slide',
      title: '油压检测讲解',
      description: '讲解检测安全步骤',
      keyPoints: ['确认压力表连接'],
      order: 2,
    };
    const content = { elements: [] } as unknown as GeneratedSlideContent;
    const groundingContext = '[Source: U660E.pdf]\n阀体油压测试前需连接指定压力表。';

    await generateSceneActions(outline, content, aiCall, { groundingContext });

    expect(capturedPrompt).toContain('Retrieved Reference Material');
    expect(capturedPrompt).toContain(groundingContext);
    expect(capturedPrompt).toContain('Do not mention source files or retrieval');
  });
});
