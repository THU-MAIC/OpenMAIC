/**
 * LTI 1.3 Launch endpoint.
 *
 * The LTI platform POSTs an `id_token` JWT and `state` here. We:
 * 1. Validate the state matches a pending launch
 * 2. Verify the JWT signature against the platform's JWKS
 * 3. Create or link the OpenMAIC user
 * 4. Redirect into the appropriate course/lesson
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { jwtVerify, createRemoteJWKSet } from 'jose';

interface LTIClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  nonce: string;
  'https://purl.imsglobal.org/spec/lti/claim/deployment_id'?: string;
  'https://purl.imsglobal.org/spec/lti/claim/roles'?: string[];
  'https://purl.imsglobal.org/spec/lti/claim/context'?: { id: string; title?: string };
  'https://purl.imsglobal.org/spec/lti/claim/custom'?: Record<string, string>;
  email?: string;
  name?: string;
}

export async function POST(req: Request) {
  const form = new URLSearchParams(await req.text());
  const idToken = form.get('id_token');
  const state = form.get('state');

  if (!idToken || !state) {
    return NextResponse.json({ error: 'Missing id_token or state' }, { status: 400 });
  }

  // Find the pending launch by state
  const launch = await prisma.lTILaunch.findFirst({ where: { state } });
  if (!launch) return NextResponse.json({ error: 'Invalid state' }, { status: 400 });

  const platform = await prisma.lTIPlatform.findUnique({ where: { id: launch.platformId } });
  if (!platform) return NextResponse.json({ error: 'Platform not found' }, { status: 404 });

  // Verify JWT against platform JWKS
  let payload: LTIClaims;
  try {
    const JWKS = createRemoteJWKSet(new URL(platform.jwksEndpoint));
    const { payload: verified } = await jwtVerify(idToken, JWKS, {
      issuer: platform.issuer,
      audience: platform.clientId,
    });
    payload = verified as unknown as LTIClaims;
  } catch (e) {
    return NextResponse.json({ error: `JWT verification failed: ${e}` }, { status: 401 });
  }

  // Validate nonce
  if (payload.nonce !== launch.nonce) {
    return NextResponse.json({ error: 'Nonce mismatch' }, { status: 401 });
  }

  // Create or link user
  const ltiUserId = payload.sub;
  const email = payload.email;
  let user = email ? await prisma.user.findUnique({ where: { email } }) : null;
  if (!user) {
    user = await prisma.user.create({
      data: {
        email: email || `${ltiUserId}@lti.local`,
        name: payload.name || `LTI ${ltiUserId.slice(0, 8)}`,
        role: 'STUDENT',
      },
    });
  }

  // Determine target course from custom claim or context
  const customCourseId =
    payload['https://purl.imsglobal.org/spec/lti/claim/custom']?.openmaic_course_id;
  const contextId = payload['https://purl.imsglobal.org/spec/lti/claim/context']?.id;

  // Update launch record with verified data
  await prisma.lTILaunch.update({
    where: { id: launch.id },
    data: {
      userId: user.id,
      ltiUserId,
      courseId: customCourseId || null,
      roles: payload['https://purl.imsglobal.org/spec/lti/claim/roles'] || [],
    },
  });

  // Redirect into the course (or homepage if no course mapping)
  const target = customCourseId
    ? `/courses/${customCourseId}`
    : contextId
      ? `/?lti_context=${contextId}`
      : '/';

  // NOTE: A real implementation would also create a NextAuth session here.
  // For brevity we redirect; the user can sign in via the regular flow if needed.
  return NextResponse.redirect(new URL(target, req.url), 302);
}
