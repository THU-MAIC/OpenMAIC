import { prisma } from '@/lib/auth/prisma';
import { NextResponse } from 'next/server';
import { PromptCategory } from '@prisma/client';
import { requirePermissions } from '@/lib/auth/helpers';

interface PromptImportItem {
  key: string;
  displayName: string;
  description?: string | null;
  content: string;
  category: PromptCategory;
  variables?: string[];
  isActive?: boolean;
}

function isPromptCategory(value: unknown): value is PromptCategory {
  return Object.values(PromptCategory).includes(value as PromptCategory);
}

function normalizeImportItem(raw: unknown): PromptImportItem | null {
  if (!raw || typeof raw !== 'object') return null;

  const item = raw as Record<string, unknown>;
  const key = typeof item.key === 'string' ? item.key.trim() : '';
  const displayName = typeof item.displayName === 'string' ? item.displayName.trim() : '';
  const content = typeof item.content === 'string' ? item.content.trim() : '';
  const category = item.category;

  if (!key || !displayName || !content || !isPromptCategory(category)) return null;

  const description = typeof item.description === 'string' ? item.description.trim() : null;
  const variables = Array.isArray(item.variables)
    ? item.variables.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    : [];

  return {
    key,
    displayName,
    description,
    content,
    category,
    variables,
    isActive: Boolean(item.isActive),
  };
}

/**
 * GET /api/admin/system-config/prompts/bulk
 * Export all prompts with full editable content.
 */
export async function GET() {
  try {
    await requirePermissions('view_prompts');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const prompts = await prisma.promptTemplate.findMany({
      orderBy: [{ category: 'asc' }, { displayName: 'asc' }],
      select: {
        id: true,
        key: true,
        displayName: true,
        description: true,
        content: true,
        category: true,
        variables: true,
        isActive: true,
        version: true,
        updatedAt: true,
      },
    });

    return NextResponse.json({ prompts }, { status: 200 });
  } catch (error) {
    console.error('[Prompts Bulk GET]', error);
    return NextResponse.json({ error: 'Failed to export prompts' }, { status: 500 });
  }
}

/**
 * POST /api/admin/system-config/prompts/bulk
 * Bulk upsert prompts by key.
 */
export async function POST(req: Request) {
  let session;
  try {
    session = await requirePermissions('create_prompts', 'edit_prompts');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const body = (await req.json()) as { prompts?: unknown[]; dryRun?: boolean };
    const rawPrompts = body.prompts;
    const dryRun = Boolean(body.dryRun);
    if (!Array.isArray(rawPrompts) || rawPrompts.length === 0) {
      return NextResponse.json({ error: 'prompts array is required' }, { status: 400 });
    }

    const parsed = rawPrompts.map((raw, index) => ({
      index,
      item: normalizeImportItem(raw),
    }));

    const invalidIndexes = parsed
      .filter((entry) => entry.item === null)
      .map((entry) => entry.index);

    if (invalidIndexes.length > 0) {
      return NextResponse.json(
        {
          error: 'Invalid prompt payload',
          invalidIndexes,
        },
        { status: 400 },
      );
    }

    let created = 0;
    let updated = 0;
    let unchanged = 0;

    for (const incoming of parsed.map((entry) => entry.item as PromptImportItem)) {
      const existing = await prisma.promptTemplate.findUnique({ where: { key: incoming.key } });

      if (!existing) {
        if (dryRun) {
          created += 1;
          continue;
        }

        await prisma.promptTemplate.create({
          data: {
            key: incoming.key,
            displayName: incoming.displayName,
            description: incoming.description || null,
            content: incoming.content,
            category: incoming.category,
            variables: incoming.variables || [],
            isActive: Boolean(incoming.isActive),
            version: 1,
            createdBy: session.user.id,
          },
        });
        created += 1;
        continue;
      }

      const contentChanged = existing.content.trim() !== incoming.content.trim();
      const metadataChanged =
        existing.displayName !== incoming.displayName ||
        (existing.description || null) !== (incoming.description || null) ||
        existing.category !== incoming.category ||
        existing.isActive !== Boolean(incoming.isActive) ||
        JSON.stringify(existing.variables) !== JSON.stringify(incoming.variables || []);

      if (!contentChanged && !metadataChanged) {
        unchanged += 1;
        continue;
      }

      if (dryRun) {
        updated += 1;
        continue;
      }

      await prisma.promptTemplate.update({
        where: { id: existing.id },
        data: {
          displayName: incoming.displayName,
          description: incoming.description || null,
          content: incoming.content,
          category: incoming.category,
          variables: incoming.variables || [],
          isActive: Boolean(incoming.isActive),
          version: contentChanged ? existing.version + 1 : existing.version,
        },
      });
      updated += 1;
    }

    return NextResponse.json(
      {
        success: true,
        dryRun,
        summary: {
          total: rawPrompts.length,
          created,
          updated,
          unchanged,
        },
      },
      { status: 200 },
    );
  } catch (error) {
    console.error('[Prompts Bulk POST]', error);
    return NextResponse.json({ error: 'Failed to import prompts' }, { status: 500 });
  }
}
