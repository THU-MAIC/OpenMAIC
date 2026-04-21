import { NextResponse } from 'next/server';

/** Legacy FastAPI: GET /api/ */
export async function GET() {
  return NextResponse.json({ message: 'SLATE API' });
}
