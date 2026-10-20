import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getDomain } from 'tldts';
import { SandboxError, sandboxInvalid } from '@/lib/sandbox/errors';

export interface PreviewGrant {
  ownerId: string;
  studyId?: string;
  environmentId: string;
  port: number;
  epoch: number;
  id: string;
  expiresAt: number;
}
function unavailable(): never {
  throw new SandboxError('SANDBOX_PREVIEW_UNAVAILABLE', 503, 'Isolated preview is not configured.');
}
function secret(): string {
  const value = process.env.OPENMAIC_SECRET_KEY;
  if (!value || value.length < 32) return unavailable();
  return value;
}
export function previewTransport(): 'native' | 'sdk' {
  const mode = process.env.OPENMAIC_SANDBOX_PREVIEW_TRANSPORT?.trim() || 'native';
  if (mode !== 'native' && mode !== 'sdk') return unavailable();
  return mode;
}
export function previewConfig() {
  const transport = previewTransport();
  const pattern = process.env.OPENMAIC_SANDBOX_PREVIEW_ORIGIN;
  const appOrigin = process.env.OPENMAIC_APP_ORIGIN;
  if (
    !pattern ||
    !appOrigin ||
    pattern.split('{id}').length !== 2 ||
    !process.env.OPENMAIC_PREVIEW_GATEWAY_KEY ||
    process.env.OPENMAIC_PREVIEW_GATEWAY_KEY.length < 32
  )
    return unavailable();
  const base = new URL(pattern.replace('{id}', '00000000-0000-4000-8000-000000000000'));
  const app = new URL(appOrigin);
  const local = (host: string) =>
    host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1';
  if (
    base.username ||
    base.password ||
    base.pathname !== '/' ||
    base.search ||
    base.hash ||
    !base.hostname.startsWith('00000000-0000-4000-8000-000000000000.') ||
    (!['https:'].includes(base.protocol) && !(base.protocol === 'http:' && local(base.hostname))) ||
    base.origin === app.origin ||
    (!local(base.hostname) && getDomain(base.hostname) === getDomain(app.hostname))
  )
    return unavailable();
  secret();
  return { pattern, appOrigin: app.origin, transport };
}
function signature(text: string) {
  return createHmac('sha256', secret())
    .update('sandbox-preview-v1:' + text)
    .digest('base64url');
}
export function issuePreviewGrant(input: Omit<PreviewGrant, 'id' | 'expiresAt'>) {
  // Keep application cookies/storage across renewed access to the same environment/port.
  // Revocation changes epoch, so a new grant uses a new isolated origin.
  const h = createHmac('sha256', secret())
    .update('sandbox-preview-origin-v1:' + JSON.stringify(input))
    .digest('hex');
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  const grant = { ...input, id, expiresAt: Date.now() + 5 * 60_000 };
  const payload = Buffer.from(JSON.stringify(grant)).toString('base64url');
  const ticket = payload + '.' + signature(payload);
  const origin = previewConfig().pattern.replace('{id}', grant.id);
  // Fragment keeps the bearer out of HTTP request logs and referrers. The gateway exchanges it once per navigation for an HttpOnly cookie.
  return { url: origin + '/__openmaic_preview#' + ticket, expiresAt: grant.expiresAt };
}
export function verifyPreviewGrant(ticket: string, host: string): PreviewGrant {
  if (ticket.length > 4096) throw sandboxInvalid('Invalid preview ticket.');
  const [payload, sig, ...extra] = ticket.split('.');
  const expected = signature(payload ?? '');
  if (
    extra.length ||
    !sig ||
    sig.length !== expected.length ||
    !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  )
    throw new SandboxError(
      'SANDBOX_PREVIEW_FORBIDDEN',
      403,
      'Preview access expired or was refused.',
    );
  let g: PreviewGrant;
  try {
    g = JSON.parse(Buffer.from(payload, 'base64url').toString());
  } catch {
    throw sandboxInvalid('Invalid preview ticket.');
  }
  if (
    !g ||
    !/^[0-9a-f-]{36}$/.test(g.id) ||
    typeof g.ownerId !== 'string' ||
    (g.studyId !== undefined && !/^[a-f0-9-]{36}$/.test(g.studyId)) ||
    !Number.isSafeInteger(g.expiresAt) ||
    g.expiresAt <= Date.now() ||
    g.expiresAt > Date.now() + 5 * 60_000 ||
    !Number.isInteger(g.port) ||
    g.port < 1024 ||
    g.port > 65535 ||
    g.port === 49983 ||
    !Number.isInteger(g.epoch) ||
    g.epoch < 0 ||
    new URL(previewConfig().pattern.replace('{id}', g.id)).host !== host
  )
    throw new SandboxError(
      'SANDBOX_PREVIEW_FORBIDDEN',
      403,
      'Preview access expired or was refused.',
    );
  return g;
}
export function verifyGatewayRequest(body: string, value: string | null): boolean {
  const key = process.env.OPENMAIC_PREVIEW_GATEWAY_KEY;
  if (!key || key.length < 32 || !value) return false;
  const [at, sig, ...extra] = value.split('.');
  if (
    extra.length ||
    !/^\d{13}$/.test(at) ||
    Math.abs(Date.now() - Number(at)) > 30_000 ||
    !/^[a-f0-9]{64}$/.test(sig ?? '')
  )
    return false;
  const expected = createHmac('sha256', key)
    .update(at + '.' + body)
    .digest('hex');
  return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}
