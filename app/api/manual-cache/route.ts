import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

// Note: Storing in /tmp to work around serverless readonly filesystems
// However, since serverless instances are ephemeral, ideally you'd use Redis or Vercel KV.
// We are storing in /tmp and verifying hash structure to prevent Path Traversal.

export async function POST(req: Request) {
  try {
    const { hash, response } = await req.json();

    if (!hash || !response) {
      return NextResponse.json({ error: 'Missing hash or response' }, { status: 400 });
    }

    // Validate hash to be strictly 32 alphanumeric hex chars to prevent path traversal
    if (!/^[a-fA-F0-9]{32}$/.test(hash)) {
      return NextResponse.json({ error: 'Invalid hash format' }, { status: 400 });
    }

    // Since serverless is readonly outside /tmp, use /tmp
    const CACHE_DIR = path.join('/tmp', '.openmaic', 'manual_cache');
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }

    fs.writeFileSync(path.join(CACHE_DIR, `${hash}.json`), response, 'utf-8');

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unknown error' }, { status: 500 });
  }
}
