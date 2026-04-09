/**
 * Admin-only provider configuration API.
 *
 * GET  /api/admin/providers          — list all overrides (with apiKey masked)
 * PUT  /api/admin/providers          — upsert a single override
 * DELETE /api/admin/providers?id=... — remove one override
 *
 * Only ADMIN users can access these endpoints. After any mutation the
 * in-memory provider cache is invalidated so subsequent getConfig() calls
 * reload fresh values.
 */
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth/auth';
import { prisma } from '@/lib/db/prisma';
import { invalidateProviderCache } from '@/lib/server/provider-config';

const VALID_CATEGORIES = new Set(['llm', 'tts', 'asr', 'image', 'video', 'webSearch', 'pdf']);

function maskKey(key: string | null | undefined): string {
  if (!key) return '';
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

async function requireAdmin() {
  const session = await auth();
  if (!session?.user || session.user.role !== 'ADMIN') {
    return null;
  }
  return session.user;
}

export async function GET() {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const rows = await prisma.providerConfigOverride.findMany({
    orderBy: [{ category: 'asc' }, { providerId: 'asc' }],
  });

  const overrides = rows.map((r) => ({
    id: r.id,
    category: r.category,
    providerId: r.providerId,
    apiKeyMasked: maskKey(r.apiKey),
    hasApiKey: !!r.apiKey,
    baseUrl: r.baseUrl,
    models: r.models,
    proxy: r.proxy,
    enabled: r.enabled,
    updatedAt: r.updatedAt,
    updatedBy: r.updatedBy,
  }));

  return NextResponse.json({ overrides });
}

interface UpsertBody {
  category: string;
  providerId: string;
  apiKey?: string | null; // empty string = clear, null = leave as-is
  baseUrl?: string | null;
  models?: string | null;
  proxy?: string | null;
  enabled?: boolean;
}

export async function PUT(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = (await req.json()) as UpsertBody;
  if (!body.category || !VALID_CATEGORIES.has(body.category)) {
    return NextResponse.json({ error: 'Invalid category' }, { status: 400 });
  }
  if (!body.providerId) {
    return NextResponse.json({ error: 'providerId is required' }, { status: 400 });
  }

  const data: {
    category: string;
    providerId: string;
    apiKey?: string | null;
    baseUrl?: string | null;
    models?: string | null;
    proxy?: string | null;
    enabled?: boolean;
    updatedBy?: string | null;
  } = {
    category: body.category,
    providerId: body.providerId,
    updatedBy: user.id,
  };
  if (body.apiKey !== undefined) data.apiKey = body.apiKey || null;
  if (body.baseUrl !== undefined) data.baseUrl = body.baseUrl || null;
  if (body.models !== undefined) data.models = body.models || null;
  if (body.proxy !== undefined) data.proxy = body.proxy || null;
  if (body.enabled !== undefined) data.enabled = body.enabled;

  const row = await prisma.providerConfigOverride.upsert({
    where: {
      category_providerId: { category: body.category, providerId: body.providerId },
    },
    create: {
      category: body.category,
      providerId: body.providerId,
      apiKey: data.apiKey,
      baseUrl: data.baseUrl,
      models: data.models,
      proxy: data.proxy,
      enabled: data.enabled ?? true,
      updatedBy: user.id,
    },
    update: {
      apiKey: data.apiKey,
      baseUrl: data.baseUrl,
      models: data.models,
      proxy: data.proxy,
      enabled: data.enabled,
      updatedBy: user.id,
    },
  });

  invalidateProviderCache();

  return NextResponse.json({
    override: {
      id: row.id,
      category: row.category,
      providerId: row.providerId,
      apiKeyMasked: maskKey(row.apiKey),
      hasApiKey: !!row.apiKey,
      baseUrl: row.baseUrl,
      models: row.models,
      proxy: row.proxy,
      enabled: row.enabled,
      updatedAt: row.updatedAt,
    },
  });
}

export async function DELETE(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  await prisma.providerConfigOverride.delete({ where: { id } });
  invalidateProviderCache();

  return NextResponse.json({ ok: true });
}
