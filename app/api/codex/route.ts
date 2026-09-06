import { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import {
  isCodexProviderEnabled,
  logoutCodexAccount,
  readCodexProviderStatus,
  startCodexLogin,
} from '@/lib/server/codex/account';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const log = createLogger('CodexProvider');

function publicError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Codex provider request failed.';
}

export async function GET() {
  try {
    const status = await readCodexProviderStatus();
    return apiSuccess({ status });
  } catch (error) {
    log.error('Failed to read Codex provider status:', error);
    return apiError('UPSTREAM_ERROR', 502, publicError(error));
  }
}

export async function POST(request: NextRequest) {
  if (!isCodexProviderEnabled()) {
    return apiError(
      'PROVIDER_DISABLED',
      403,
      'Codex subscription provider is disabled by the server operator.',
    );
  }

  try {
    const body = (await request.json().catch(() => ({}))) as { mode?: unknown };
    if (body.mode !== undefined && body.mode !== 'browser' && body.mode !== 'device') {
      return apiError('INVALID_REQUEST', 400, 'mode must be "browser" or "device".');
    }

    const login = await startCodexLogin(body.mode === 'device' ? 'device' : 'browser');
    return apiSuccess({ login });
  } catch (error) {
    log.error('Failed to start Codex login:', error);
    return apiError('UPSTREAM_ERROR', 502, publicError(error));
  }
}

export async function DELETE() {
  if (!isCodexProviderEnabled()) {
    return apiError(
      'PROVIDER_DISABLED',
      403,
      'Codex subscription provider is disabled by the server operator.',
    );
  }

  try {
    await logoutCodexAccount();
    return apiSuccess({});
  } catch (error) {
    log.error('Failed to sign out of the Codex provider:', error);
    return apiError('UPSTREAM_ERROR', 502, publicError(error));
  }
}
