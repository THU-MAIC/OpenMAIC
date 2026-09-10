/**
 * /api/stages — the workbench's course-document index and create face.
 *
 * Every handler is owner-scoped exactly like the agent tools: the owner
 * resolves from the anonymous cookie (`withRequestOwnerId`) and is never a
 * request parameter, and all reads and writes go through the owner-bound
 * document store (`getOwnerScopedDocumentStore`), the same seam the runner
 * binds for the stage tools. A stage created here is visible to this browser
 * and to nobody else.
 *
 * The configured runtime gates the whole family: these routes serve the
 * workbench, which is agent-runtime territory, so a runtime that is off OR
 * enabled without a DATABASE_URL answers the same plain 404 as the agent
 * control-plane routes — never a 500 from a store that cannot connect.
 */
import type { NextRequest } from 'next/server';
import { randomBytes } from 'node:crypto';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import type { AppDocumentOutline } from '@/lib/document-store/persistence-types';
import { apiError } from '@/lib/server/api-response';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { STAGE_NAME_MAX_LENGTH } from '@/lib/server/agent-runtime/stage-limits';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';

export const runtime = 'nodejs';

/** Mint a fresh, collision-free course id in the same `stage-` family as the agent tools. */
function createStageId(): string {
  return `stage-${randomBytes(9).toString('base64url')}`;
}

// GET /api/stages — list every stage document owned by the caller.
export async function GET(req: NextRequest) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const store = await getOwnerScopedDocumentStore(ownerId);
    const stages = await store.listDocuments();
    return ownerJson({ stages }, 200, responseHeaders);
  });
}

// POST /api/stages — create a stage document shell { name, description? }.
//
// Validation happens before owner resolution, like the agent session routes:
// a malformed body must not mint an anonymous cookie partition for a request
// that will not proceed.
export async function POST(req: NextRequest) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError('INVALID_REQUEST', 400, 'invalid JSON body');
  }
  if (typeof body !== 'object' || body === null) {
    return apiError('INVALID_REQUEST', 400, 'request body must be a JSON object');
  }
  const { name, description } = body as { name?: unknown; description?: unknown };
  if (typeof name !== 'string' || name.trim().length === 0) {
    return apiError('MISSING_REQUIRED_FIELD', 400, 'name is required');
  }
  const trimmedName = name.trim();
  if (trimmedName.length > STAGE_NAME_MAX_LENGTH) {
    return apiError(
      'INVALID_REQUEST',
      400,
      `name exceeds the ${STAGE_NAME_MAX_LENGTH} character limit`,
    );
  }
  if (description !== undefined && typeof description !== 'string') {
    return apiError('INVALID_REQUEST', 400, 'description must be a string when present');
  }
  const trimmedDescription = description?.trim();

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const id = createStageId();
    const now = Date.now();
    const outline: AppDocumentOutline = {
      outlines: [],
      requirement: trimmedName,
      generationComplete: false,
      createdAt: now,
      updatedAt: now,
    };
    const store = await getOwnerScopedDocumentStore(ownerId);
    await store.saveDocument({
      stage: {
        id,
        name: trimmedName,
        ...(trimmedDescription ? { description: trimmedDescription } : {}),
        createdAt: now,
        updatedAt: now,
      },
      scenes: [],
      outline,
    });
    return ownerJson(
      {
        stage: {
          id,
          name: trimmedName,
          ...(trimmedDescription ? { description: trimmedDescription } : {}),
          createdAt: now,
          updatedAt: now,
          sceneCount: 0,
        },
      },
      201,
      responseHeaders,
    );
  });
}
