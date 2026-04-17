import { NextResponse } from 'next/server';
import { requireAnyPermissions } from '@/lib/auth/helpers';

/**
 * GET /api/admin/system-config/prompts/categories
 * Get available prompt categories
 */
export async function GET() {
  try {
    await requireAnyPermissions('view_prompts', 'create_prompts', 'edit_prompts');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const categories = [
      { value: 'SYSTEM', label: 'System' },
      { value: 'GENERATION', label: 'Generation' },
      { value: 'GRADING', label: 'Grading' },
      { value: 'ANALYSIS', label: 'Analysis' },
      { value: 'CHAT', label: 'Chat' },
    ];

    return NextResponse.json({ categories }, { status: 200 });
  } catch (error) {
    console.error('[Prompt Categories GET]', error);
    return NextResponse.json({ error: 'Failed to fetch categories' }, { status: 500 });
  }
}
