/**
 * Import waitlist rows from a pasted MongoDB UI export (free-form text).
 *
 * Expected to contain repeating blocks like:
 *   <email> <uuid> <dd/mm/yyyy, hh:mm:ss>
 *
 * Usage:
 *   pnpm import:waitlist ./waitlist.txt
 *
 * Env (from .env.local):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: pnpm import:waitlist ./waitlist.txt');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type ParsedRow = { email: string; id: string; joined_at: string };

function parseDdMmYyyyTime(raw: string): string | null {
  // Matches "21/04/2026, 10:47:15"
  const m = raw.match(/(\d{2})\/(\d{2})\/(\d{4}),\s*(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, dd, mm, yyyy, HH, MM, SS] = m;

  // Interpret as local time and convert to ISO. (If you prefer UTC, replace with Date.UTC.)
  const d = new Date(
    Number(yyyy),
    Number(mm) - 1,
    Number(dd),
    Number(HH),
    Number(MM),
    Number(SS),
    0,
  );
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function extractRows(text: string): ParsedRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const uuidRe =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

  const out: ParsedRow[] = [];

  for (let i = 0; i < lines.length; i++) {
    // Lines often look like: "gyu@rdtfy.com 3ee2b666-db5e-42be-b309-8ecbcece3001 21/04/2026, 10:47:15"
    const parts = lines[i].split(/\s+/);
    const email = parts[0]?.trim();
    const id = parts[1]?.trim();

    if (!email || !id) continue;
    if (!emailRe.test(email.toLowerCase())) continue;
    if (!uuidRe.test(id)) continue;

    const joinedAtIso = parseDdMmYyyyTime(lines[i]);
    if (!joinedAtIso) continue;

    out.push({ email: email.toLowerCase(), id, joined_at: joinedAtIso });
  }

  // De-dupe by lower(email) (matches DB uniqueness)
  const seen = new Set<string>();
  return out.filter((r) => {
    if (seen.has(r.email)) return false;
    seen.add(r.email);
    return true;
  });
}

async function main() {
  const txt = await readFile(inputPath, 'utf8');
  const rows = extractRows(txt);
  console.log(`Parsed ${rows.length} waitlist rows`);

  let inserted = 0;
  let skipped = 0;

  // Batch insert to keep PostgREST happy
  const batchSize = 500;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await supabase.from('waitlist').insert(batch);
    if (!error) {
      inserted += batch.length;
      continue;
    }

    // If a batch hits duplicates, fall back to row-by-row to maximize imports
    for (const row of batch) {
      const { error: e2 } = await supabase.from('waitlist').insert(row);
      if (e2?.code === '23505') skipped++;
      else if (e2) console.error('Insert failed', row.email, e2.message);
      else inserted++;
    }
  }

  console.log(`Done. inserted=${inserted} skipped_duplicates=${skipped}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

