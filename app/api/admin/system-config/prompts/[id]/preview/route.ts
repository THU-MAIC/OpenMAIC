import { prisma } from '@/lib/auth/prisma';
import { NextResponse } from 'next/server';
import { requirePermissions } from '@/lib/auth/helpers';

/**
 * POST /api/admin/system-config/prompts/[id]/preview
 * Preview a prompt with variable substitution
 */
export async function POST(
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
    const body = await req.json();
    const { variables } = body;

    const prompt = await prisma.promptTemplate.findUnique({
      where: { id },
    });

    if (!prompt) {
      return NextResponse.json({ error: 'Prompt not found' }, { status: 404 });
    }

    // Perform variable substitution
    let rendered = prompt.content;
    if (variables) {
      Object.entries(variables).forEach(([key, value]) => {
        rendered = rendered.replace(new RegExp(`{{${key}}}`, 'g'), String(value));
      });
    }

    // Replace any unused variables with empty string
    rendered = rendered.replace(/{{[^}]+}}/g, '');

    return NextResponse.json(
      {
        id: prompt.id,
        key: prompt.key,
        displayName: prompt.displayName,
        original: prompt.content,
        rendered,
        variables: prompt.variables,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('[Prompt Preview]', error);
    return NextResponse.json({ error: 'Failed to preview prompt' }, { status: 500 });
  }
}
