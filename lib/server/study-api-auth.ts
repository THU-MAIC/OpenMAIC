import { type NextRequest } from 'next/server';
import { apiError } from '@/lib/server/api-response';

function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function requireStudyApiBearerAuth(req: NextRequest) {
  const expected = process.env.STUDY_API_BEARER_TOKEN?.trim();
  if (!expected) {
    return null;
  }

  const auth = req.headers.get('authorization')?.trim() || '';
  if (!auth.toLowerCase().startsWith('bearer ')) {
    return apiError('INVALID_REQUEST', 401, 'Missing bearer token');
  }

  const provided = auth.slice(7).trim();
  if (!provided || !timingSafeEqualString(provided, expected)) {
    return apiError('INVALID_REQUEST', 403, 'Invalid bearer token');
  }

  return null;
}
