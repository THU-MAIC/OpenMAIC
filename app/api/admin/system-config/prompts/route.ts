import { prisma } from '@/lib/auth/prisma';
import { NextResponse } from 'next/server';
import { PromptCategory } from '@prisma/client';
import { getAllPromptKeys, getPromptKeyMetadata } from '@/lib/admin/prompt-keys';
import { getDefaultPrompt } from '@/lib/admin/default-prompts';
import { requirePermissions } from '@/lib/auth/helpers';

async function ensureBuiltInPrompts(createdBy: string) {
  const keys = getAllPromptKeys();

  for (const key of keys) {
    const metadata = getPromptKeyMetadata(key);
    const content = getDefaultPrompt(key);
    if (!metadata || !content) continue;

    await prisma.promptTemplate.upsert({
      where: { key },
      update: {},
      create: {
        key,
        displayName: metadata.label,
        description: metadata.description,
        content,
        category: metadata.category as PromptCategory,
        variables: [],
        version: 1,
        isActive: true,
        createdBy,
      },
    });
  }
}

/**
 * GET /api/admin/system-config/prompts
 * List all prompt templates
 */
export async function GET() {
  let session;
  try {
    session = await requirePermissions('view_prompts');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    await ensureBuiltInPrompts(session.user.id);

    const prompts = await prisma.promptTemplate.findMany({
      orderBy: [{ category: 'asc' }, { displayName: 'asc' }],
      select: {
        id: true,
        key: true,
        displayName: true,
        description: true,
        category: true,
        isActive: true,
        version: true,
        createdBy: true,
        createdAt: true,
      },
    });

    return NextResponse.json({ prompts }, { status: 200 });
  } catch (error) {
    console.error('[Prompts GET]', error);
    return NextResponse.json({ error: 'Failed to fetch prompts' }, { status: 500 });
  }
}

/**
 * POST /api/admin/system-config/prompts
 * Create a new prompt template
 */
export async function POST(req: Request) {
  let session;
  try {
    session = await requirePermissions('create_prompts');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const body = await req.json();
    const { key, displayName, description, content, category, variables } = body;

    // Validation
    if (!key?.trim()) {
      return NextResponse.json({ error: 'Key is required' }, { status: 400 });
    }
    if (!displayName?.trim()) {
      return NextResponse.json({ error: 'Display name is required' }, { status: 400 });
    }
    if (!content?.trim()) {
      return NextResponse.json({ error: 'Content is required' }, { status: 400 });
    }
    if (!category) {
      return NextResponse.json({ error: 'Category is required' }, { status: 400 });
    }

    // Check for duplicate key
    const existing = await prisma.promptTemplate.findUnique({ where: { key } });
    if (existing) {
      return NextResponse.json({ error: 'Key already exists' }, { status: 409 });
    }

    const prompt = await prisma.promptTemplate.create({
      data: {
        key: key.trim(),
        displayName: displayName.trim(),
        description: description?.trim() || null,
        content: content.trim(),
        category,
        variables: variables || [],
        version: 1,
        isActive: false,
        createdBy: session.user.id,
      },
    });

    // Fire-and-forget audit log
    fetch('http://localhost:3000/api/admin/audit-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'CREATE_PROMPT',
        resourceId: prompt.id,
        resourceType: 'PromptTemplate',
        details: { key, displayName },
      }),
    }).catch(console.error);

    return NextResponse.json(prompt, { status: 201 });
  } catch (error) {
    console.error('[Prompts POST]', error);
    return NextResponse.json({ error: 'Failed to create prompt' }, { status: 500 });
  }
}
