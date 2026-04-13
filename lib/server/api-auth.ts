/**
 * API Key Authentication
 *
 * Simple bearer-token authentication for external API consumers
 * (e.g. learning.thomhoffer.nl calling generation/grading endpoints).
 *
 * When LEARNING_API_KEY is set, requests must include:
 *   Authorization: Bearer <key>
 *
 * When LEARNING_API_KEY is not set, all requests are allowed (dev mode).
 */

import type { NextRequest } from 'next/server';

/**
 * Validate the API key from the Authorization header.
 * Returns true if the request is authorized.
 */
export function validateApiKey(req: NextRequest): boolean {
  const expected = process.env.LEARNING_API_KEY;
  if (!expected) return true; // no key configured → open (dev mode)
  const auth = req.headers.get('Authorization');
  return auth === `Bearer ${expected}`;
}
