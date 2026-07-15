/**
 * LearnWorlds LMS Integration API
 *
 * POST: Acts as an MCP client against the user-configured Learnworlds-MCP
 * server (https://github.com/ohneben/Learnworlds-MCP).
 *
 * Actions:
 * - `test`:    connect + list tools to validate the configuration.
 * - `publish`: create the course and its sections in the LearnWorlds school.
 *
 * Credentials arrive in the request body (persisted only in the caller's
 * browser) and are never stored or logged on the server.
 */
import { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import {
  publishCourseToLearnWorlds,
  testLearnWorldsConnection,
} from '@/lib/server/learnworlds-mcp';
import type { LearnWorldsApiRequest } from '@/lib/lms/types';
import { validateLearnWorldsConfig } from '@/lib/lms/types';

const log = createLogger('LMS LearnWorlds');

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  let body: LearnWorldsApiRequest;
  try {
    body = (await req.json()) as LearnWorldsApiRequest;
  } catch {
    return apiError('INVALID_REQUEST', 400, 'Invalid JSON body');
  }

  const { action, config, course } = body;
  if (!action || !config) {
    return apiError('MISSING_REQUIRED_FIELD', 400, 'action and config are required');
  }

  const missing = validateLearnWorldsConfig(config);
  if (missing.length > 0) {
    return apiError(
      'MISSING_REQUIRED_FIELD',
      400,
      `Incomplete LearnWorlds configuration: ${missing.join(', ')}`,
    );
  }

  try {
    if (action === 'test') {
      log.info('Testing LearnWorlds MCP connection', { transport: config.transport });
      const result = await testLearnWorldsConnection(config);
      return apiSuccess({ result });
    }

    if (action === 'publish') {
      if (!course || !course.title || !course.titleId) {
        return apiError(
          'MISSING_REQUIRED_FIELD',
          400,
          'course payload with title and titleId is required for publish',
        );
      }
      log.info('Publishing course to LearnWorlds', {
        transport: config.transport,
        title: course.title,
        sections: course.sections.length,
      });
      const result = await publishCourseToLearnWorlds(config, course);
      return apiSuccess({ result });
    }

    return apiError('INVALID_REQUEST', 400, `Unknown action: ${String(action)}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('LearnWorlds API error', { message });
    return apiError('UPSTREAM_ERROR', 502, message);
  }
}
