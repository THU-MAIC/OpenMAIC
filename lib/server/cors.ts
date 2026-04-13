/**
 * CORS Headers Utility
 *
 * Provides cross-origin headers so external apps (e.g. learning.thomhoffer.nl)
 * can call OpenMAIC API endpoints from the browser.
 */

import { NextRequest, NextResponse } from 'next/server';

const ALLOWED_ORIGINS: string[] = [
  'https://learning.thomhoffer.nl',
  ...(process.env.LEARNING_APP_ORIGIN ? [process.env.LEARNING_APP_ORIGIN] : []),
];

const CORS_HEADERS_BASE = {
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, x-model, x-api-key, x-base-url, x-provider-type',
  'Access-Control-Max-Age': '86400',
};

/**
 * Build CORS response headers for a given request origin.
 * Returns an empty Allow-Origin if the origin is not allowed.
 */
export function corsHeaders(origin?: string | null): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin);
  return {
    'Access-Control-Allow-Origin': allowed ? origin : '',
    ...CORS_HEADERS_BASE,
  };
}

/**
 * Extract the Origin header from a request.
 */
export function getOrigin(req: NextRequest): string | null {
  return req.headers.get('Origin');
}

/**
 * Standard OPTIONS handler for CORS preflight.
 * Use as: export { corsOptionsHandler as OPTIONS } from '@/lib/server/cors';
 */
export async function corsOptionsHandler(req: NextRequest): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(getOrigin(req)),
  });
}
