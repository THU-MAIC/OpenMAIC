import { prisma } from '@/lib/auth/prisma';
import { NextResponse } from 'next/server';
import { hasServerPermission, requirePermissions } from '@/lib/auth/helpers';

/**
 * GET /api/admin/system-config/prompts/[id]
 * Get a specific prompt template
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requirePermissions('view_prompts');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const { id } = await params;

    const prompt = await prisma.promptTemplate.findUnique({
      where: { id },
    });

    if (!prompt) {
      return NextResponse.json({ error: 'Prompt not found' }, { status: 404 });
    }

    return NextResponse.json(prompt, { status: 200 });
  } catch (error) {
    console.error('[Prompt GET]', error);
    return NextResponse.json({ error: 'Failed to fetch prompt' }, { status: 500 });
  }
}

/**
 * PATCH /api/admin/system-config/prompts/[id]
 * Update a prompt template (creates new version)
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requirePermissions('edit_prompts');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const { id } = await params;
    const body = await req.json();
    const { displayName, description, content, variables, isActive } = body;

    const prompt = await prisma.promptTemplate.findUnique({
      where: { id },
    });

    if (!prompt) {
      return NextResponse.json({ error: 'Prompt not found' }, { status: 404 });
    }

    if (isActive !== undefined && isActive !== prompt.isActive) {
      const canPublish = await hasServerPermission('publish_prompts');
      if (!canPublish) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }

    // Build update data
    const updateData: any = {
      updatedAt: new Date(),
    };

    if (displayName !== undefined) updateData.displayName = displayName.trim();
    if (description !== undefined) updateData.description = description?.trim() || null;
    if (content !== undefined) {
      updateData.content = content.trim();
      updateData.version = prompt.version + 1; // Increment version on content change
    }
    if (variables !== undefined) updateData.variables = variables;
    if (isActive !== undefined) updateData.isActive = isActive;

    const updated = await prisma.promptTemplate.update({
      where: { id },
      data: updateData,
    });

    // Fire-and-forget audit log
    fetch('http://localhost:3000/api/admin/audit-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'UPDATE_PROMPT',
        resourceId: id,
        resourceType: 'PromptTemplate',
        details: { displayName, version: updated.version },
      }),
    }).catch(console.error);

    return NextResponse.json(updated, { status: 200 });
  } catch (error) {
    console.error('[Prompt PATCH]', error);
    return NextResponse.json({ error: 'Failed to update prompt' }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/system-config/prompts/[id]
 * Delete a prompt template
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requirePermissions('delete_prompts');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const { id } = await params;

    const prompt = await prisma.promptTemplate.findUnique({
      where: { id },
    });

    if (!prompt) {
      return NextResponse.json({ error: 'Prompt not found' }, { status: 404 });
    }

    await prisma.promptTemplate.delete({
      where: { id },
    });

    // Fire-and-forget audit log
    fetch('http://localhost:3000/api/admin/audit-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'DELETE_PROMPT',
        resourceId: id,
        resourceType: 'PromptTemplate',
        details: { key: prompt.key },
      }),
    }).catch(console.error);

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('[Prompt DELETE]', error);
    return NextResponse.json({ error: 'Failed to delete prompt' }, { status: 500 });
  }
}
