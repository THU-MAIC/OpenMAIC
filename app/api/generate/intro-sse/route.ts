import { NextRequest } from 'next/server';
import { generateIntroScript } from '@/lib/generation/intro-streaming';
import { createLogger } from '@/lib/logger';
import { resolveGenerationLanguage } from '@/lib/constants/generation';

const log = createLogger('IntroSSE');

export const maxDuration = 300;

/**
 * SSE Endpoint for prioritized course introduction.
 * Returns a stream of text (script) and audio chunks (base64).
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { stageId, name, description, language, voiceId: requestedVoiceId } = body;

  if (!name || !stageId) {
    return new Response('Missing name or stageId', { status: 400 });
  }

  // 1. Establish SSE stream
  const encoder = new TextEncoder();
  
  const stream = new ReadableStream({
    async start(controller) {
      const sendEvent = (event: string, data: any) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      try {
        log.info(`Starting intro generation for: ${name} (${stageId})`);

        // Step 1: Generate the script
        const script = await generateIntroScript({
          courseName: name,
          courseDescription: description,
          language: resolveGenerationLanguage(language),
        });

        // Send the complete script early so the UI can show it
        sendEvent('script', { text: script });

        // Step 2: Stream TTS from Smallest AI (Waves)
        const apiKey = process.env.TTS_SMALLEST_API_KEY || process.env.SMALLEST_API_KEY;
        if (!apiKey) {
          throw new Error('Smallest AI API key not found');
        }

        // Voice selection: Use requestedVoiceId, fallback to language-based defaults
        const isEnglish = language?.startsWith('en');
        const voiceId = requestedVoiceId || (isEnglish ? 'magnus' : 'daniel');

        const ttsResponse = await fetch('https://api.smallest.ai/waves/v1/lightning-v3.1/get_speech', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text: script,
            voice_id: voiceId,
            sample_rate: 24000,
            speed: 1.25,
            output_format: 'pcm',
          }),
        });

        if (!ttsResponse.ok) {
          const errorText = await ttsResponse.text();
          throw new Error(`Smallest AI TTS error: ${errorText}`);
        }

        if (!ttsResponse.body) {
          throw new Error('Smallest AI TTS response body is empty');
        }

        // Step 3: Read chunks from the TTS response and push as base64 SSE events
        const reader = ttsResponse.body.getReader();
        
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // Convert chunk to base64
          const base64 = Buffer.from(value).toString('base64');
          sendEvent('audio', { chunk: base64 });
        }

        sendEvent('done', { success: true });
        log.info(`Intro generation completed for: ${stageId}`);
      } catch (error) {
        log.error('Intro SSE failed:', error);
        sendEvent('error', { message: error instanceof Error ? error.message : 'Unknown error' });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
