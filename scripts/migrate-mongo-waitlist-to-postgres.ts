/**
 * One-time migration: MongoDB (legacy FastAPI) → Supabase Postgres.
 *
 * Required env (e.g. in .env.local):
 *   MONGO_URL          — full Mongo connection string
 *   MONGO_DB_NAME      — database name (same as FastAPI DB_NAME)
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Apply the migration `20260421120000_waitlist_status_checks.sql` first.
 *
 * Run: pnpm exec tsx --env-file=.env.local scripts/migrate-mongo-waitlist-to-postgres.ts
 */
import { randomUUID } from 'crypto';
import { MongoClient } from 'mongodb';
import { createClient } from '@supabase/supabase-js';

const mongoUrl = process.env.MONGO_URL;
const mongoDbName = process.env.MONGO_DB_NAME;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!mongoUrl || !mongoDbName) {
  console.error('Missing MONGO_URL or MONGO_DB_NAME');
  process.exit(1);
}
if (!supabaseUrl || !serviceKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }
  return new Date().toISOString();
}

async function main() {
  const client = new MongoClient(mongoUrl);
  await client.connect();
  const db = client.db(mongoDbName);

  const waitlistDocs = await db.collection('waitlist').find({}).toArray();
  const statusDocs = await db.collection('status_checks').find({}).toArray();

  console.log(`Mongo: ${waitlistDocs.length} waitlist, ${statusDocs.length} status_checks`);

  let waitlistInserted = 0;
  let waitlistSkipped = 0;
  for (const doc of waitlistDocs) {
    const emailRaw = typeof doc.email === 'string' ? doc.email.trim().toLowerCase() : '';
    if (!emailRaw || !emailRaw.includes('@')) continue;
    const id = typeof doc.id === 'string' && doc.id ? doc.id : randomUUID();
    const joined_at = toIso(doc.joined_at);

    const { error } = await supabase.from('waitlist').insert({ id, email: emailRaw, joined_at });
    if (error?.code === '23505') {
      waitlistSkipped++;
    } else if (error) {
      console.error('waitlist insert failed', emailRaw, error.message);
    } else {
      waitlistInserted++;
    }
  }

  let statusInserted = 0;
  let statusSkipped = 0;
  for (const doc of statusDocs) {
    const id = typeof doc.id === 'string' && doc.id ? doc.id : randomUUID();
    const client_name = typeof doc.client_name === 'string' ? doc.client_name : 'unknown';
    const timestamp = toIso(doc.timestamp);

    const { error } = await supabase.from('status_checks').insert({ id, client_name, timestamp });
    if (error?.code === '23505') {
      statusSkipped++;
    } else if (error) {
      console.error('status_checks insert failed', id, error.message);
    } else {
      statusInserted++;
    }
  }

  await client.close();
  console.log(
    `Done. waitlist inserted ${waitlistInserted}, skipped duplicate ${waitlistSkipped}; status_checks inserted ${statusInserted}, skipped ${statusSkipped}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
