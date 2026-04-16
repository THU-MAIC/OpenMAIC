import { callLLM } from '@/lib/ai/llm';
import { createLogger } from '@/lib/logger';
import { resolveModel } from '@/lib/server/resolve-model';

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
  const { courseName, courseDescription } = params;

  const systemPrompt = `You are an enthusiastic AI teacher at Slate. 
Your goal is to welcome a student to their brand-new course and get them excited!
Keep the tone professional yet high-energy and encouraging.
The script should be around 150-200 words.`;

  const userPrompt = `Create a greeting script for the course: "${courseName}".
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

Write ONLY the spoken script. No stage directions.`;

  try {
    const { model: languageModel, modelInfo } = resolveModel({});
    const result = await callLLM(
      {
        model: languageModel,
        system: systemPrompt,
        prompt: userPrompt,
        temperature: 0.7,
        maxOutputTokens: Math.min(1000, modelInfo?.outputWindow ?? 1000),
      },
      'intro-script',
    );

    return result.text.trim();
  } catch (error) {
    log.error('Failed to generate intro script:', error);
    return `Welcome to ${courseName}! I'm so excited to start this learning journey with you. We'll explore interactive slides, talk to AI students, and earn your certificate! Let's dive in.`;
  }
}
