import { callLLM } from '@/lib/ai/llm';
import { createLogger } from '@/lib/logger';

const log = createLogger('IntroStreaming');

export interface IntroScriptParams {
  courseName: string;
  courseDescription?: string;
  language?: string;
}

/**
 * Generates a high-energy, exciting introduction script for a new course.
 * The script walks the student through Slate's features.
 */
export async function generateIntroScript(params: IntroScriptParams): Promise<string> {
  const { courseName, courseDescription, language = 'zh-CN' } = params;

  const isEnglish = language.startsWith('en');

  const systemPrompt = isEnglish
    ? `You are an enthusiastic AI teacher at Slate. 
Your goal is to welcome a student to their brand-new course and get them excited!
Keep the tone professional yet high-energy and encouraging.
The script should be around 150-200 words.`
    : `你是一位在 Slate 的热情的 AI 老师。
你的目标是欢迎学生开启他们的新课程，并让他们感到兴奋！
语气要专业且充满活力，富有鼓励性。
脚本长度大约在 300-400 字左右。`;

  const userPrompt = isEnglish
    ? `Create a greeting script for the course: "${courseName}".
Description: ${courseDescription || 'No description provided.'}

Include these points in the walkthrough:
1. Enthusiastic welcome to the course "${courseName}".
2. Explain the classroom structure:
   - Interactive Slides: High-quality visuals that you can interact with.
   - Live Lecture: I will be teaching you in real-time.
   - AI Students: You're not alone! You'll see other AI students who might ask questions or share thoughts.
   - Voice Interactions: You can talk to me directly and ask questions anytime.
   - Practice & Quizzes: Stay sharp with interactive knowledge checks.
3. Motivation: Mention the Leaderboard and the Certificate you'll earn at the end.
4. Final Call to Action: Start the first slide!

Write ONLY the spoken script. No stage directions.`
    : `为课程 "${courseName}" 创建一段欢迎脚本。
课程描述: ${courseDescription || '无描述'}

在介绍中包含以下亮点：
1. 热情地欢迎学生参加 "${courseName}" 课程。
2. 解释教室结构：
   - 交互式课件：你可以互动的的高质量视觉效果。
   - 现场授课：我将实时为你讲解。
   - AI 同学：你并不孤单！你会看到其他 AI 同学，他们会提问或分享想法。
   - 语音互动：你可以随时直接跟我对话并提问。
   - 练习与测验：通过即时知识检查保持敏锐。
3. 动力：提到排行榜和你最后将获得的证书。
4. 最后的行动号召：让我们开始第一张幻灯片吧！

只写出朗读脚本，不要包含任何旁白或动作说明。`;

  try {
    const result = await callLLM({
      system: systemPrompt,
      prompt: userPrompt,
      temperature: 0.7,
      maxOutputTokens: 1000,
    }, 'intro-script');

    return result.text.trim();
  } catch (error) {
    log.error('Failed to generate intro script:', error);
    // Return a safe fallback script
    return isEnglish 
      ? `Welcome to ${courseName}! I'm so excited to start this learning journey with you. We'll explore interactive slides, talk to AI students, and earn your certificate! Let's dive in.`
      : `欢迎来到 ${courseName}！我非常高兴能和你一起开启这段学习之旅。我们将一起探索交互式幻灯片，与 AI 同学交流，并最终赢得你的证书！让我们开始吧。`;
  }
}
