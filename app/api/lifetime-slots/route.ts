import { NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/admin';

/**
 * GET /api/lifetime-slots
 * Public endpoint — returns how many lifetime plan spots are taken / available.
 */
export async function GET() {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from('lifetime_slots')
      .select('slots_taken, max_slots')
      .eq('id', 1)
      .single();

    if (error || !data) {
      return NextResponse.json({ slots: { taken: 0, max: 100 } });
    }

    return NextResponse.json({
      slots: { taken: data.slots_taken, max: data.max_slots },
    });
  } catch {
    return NextResponse.json({ slots: { taken: 0, max: 100 } });
  }
}
