/**
 * Expose OpenMAIC's public JWKS so LTI platforms can verify our signed tokens.
 *
 * In production, generate an RSA keypair once and store securely (env vars or
 * a secret manager). The private key is used to sign LTI deep linking and AGS
 * service requests; the public key (in JWK form) is served here.
 */
import { NextResponse } from 'next/server';

export async function GET() {
  const publicJwk = process.env.LTI_PUBLIC_JWK;
  if (!publicJwk) {
    return NextResponse.json({ keys: [] });
  }
  try {
    const key = JSON.parse(publicJwk);
    return NextResponse.json({ keys: [key] });
  } catch {
    return NextResponse.json({ keys: [] });
  }
}
