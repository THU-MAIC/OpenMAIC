/**
 * LTI 1.3 OIDC Login Initiation endpoint.
 *
 * Moodle (or any LTI 1.3 platform) POSTs here when a user clicks the tool link.
 * We respond by redirecting to the platform's auth endpoint with the
 * required OIDC parameters.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { randomBytes } from 'node:crypto';

export async function POST(req: Request) {
  return handle(req);
}
export async function GET(req: Request) {
  return handle(req);
}

async function handle(req: Request) {
  const url = new URL(req.url);
  const params =
    req.method === 'POST'
      ? new URLSearchParams(await req.text())
      : url.searchParams;

  const iss = params.get('iss');
  const loginHint = params.get('login_hint');
  const targetLinkUri = params.get('target_link_uri');
  const ltiMessageHint = params.get('lti_message_hint') || undefined;
  const clientIdParam = params.get('client_id') || undefined;
  const ltiDeploymentId = params.get('lti_deployment_id') || undefined;

  if (!iss || !loginHint || !targetLinkUri) {
    return NextResponse.json({ error: 'Missing required LTI parameters' }, { status: 400 });
  }

  const platform = await prisma.lTIPlatform.findUnique({ where: { issuer: iss } });
  if (!platform) {
    return NextResponse.json({ error: 'Unknown LTI platform' }, { status: 404 });
  }

  const state = randomBytes(16).toString('hex');
  const nonce = randomBytes(16).toString('hex');

  // Persist nonce for validation in the launch step
  await prisma.lTILaunch.create({
    data: {
      platformId: platform.id,
      ltiUserId: loginHint,
      nonce,
      state,
      roles: [],
    },
  });

  const authParams = new URLSearchParams({
    scope: 'openid',
    response_type: 'id_token',
    client_id: clientIdParam || platform.clientId,
    redirect_uri: targetLinkUri,
    login_hint: loginHint,
    state,
    response_mode: 'form_post',
    nonce,
    prompt: 'none',
  });
  if (ltiMessageHint) authParams.set('lti_message_hint', ltiMessageHint);
  if (ltiDeploymentId) authParams.set('lti_deployment_id', ltiDeploymentId);

  const redirectUrl = `${platform.authEndpoint}?${authParams.toString()}`;
  return NextResponse.redirect(redirectUrl, 302);
}
