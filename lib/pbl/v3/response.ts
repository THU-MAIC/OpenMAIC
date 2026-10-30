import { sandboxErrorMessage } from '@/lib/sandbox/error-message';
import { SandboxRequestError } from '@/components/sandbox/client';

/** Decode PBL API data without exposing empty/truncated gateway bodies as JSON exceptions. */
export async function readPblJson(response: Response) {
  try {
    const data = await response.json();
    if (data === null || typeof data !== 'object') throw new Error('Invalid API data');
    return data;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new SandboxRequestError(
      sandboxErrorMessage({ code: 'SANDBOX_UNAVAILABLE' }),
      response.status,
      'SANDBOX_UNAVAILABLE',
    );
  }
}
