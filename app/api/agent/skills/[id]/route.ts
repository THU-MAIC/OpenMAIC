/**
 * One user-owned Skill body, without bloating the global picker payload.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import {
  deleteUserSkill,
  findUserSkill,
  UserSkillError,
} from '@/lib/server/agent-runtime/user-skills';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';

export const runtime = 'nodejs';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });
  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const { id } = await params;
    const skill = await findUserSkill(id, ownerId);
    if (!skill) return new Response('Not found', { status: 404 });
    return NextResponse.json(
      { id: skill.id, content: skill.content },
      { headers: responseHeaders },
    );
  });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });
  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const { id } = await params;
    if (!id.startsWith('usk_')) {
      return new Response('Built-in skills cannot be deleted.', {
        status: 405,
        headers: responseHeaders,
      });
    }
    try {
      await deleteUserSkill(ownerId, id);
      return new Response(null, { status: 204, headers: responseHeaders });
    } catch (error) {
      if (error instanceof UserSkillError && error.code === 'not-found') {
        return new Response('Not found', { status: 404, headers: responseHeaders });
      }
      throw error;
    }
  });
}
