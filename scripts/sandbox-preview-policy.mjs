/** Preview is cross-site even on localhost. Lax cookies cannot authorize an iframe.
 * Partition by embedding site so third-party-cookie blocking need not break it.
 * Secure is required for None/Partitioned; localhost is a browser-dependent exception
 * to HTTPS, not a reason to weaken the deployed cookie policy. */
export function previewAuthorizationCookies(name, ticket, expiresAt) {
  const scope = `${name}=; Path=/; HttpOnly; SameSite=None; Secure`;
  return [
    // Retire the pre-partitioned cookie. Otherwise new-tab access can send both
    // versions after an upgrade and the gateway correctly rejects ambiguity.
    `${scope}; Max-Age=0`,
    `${name}=${ticket}; Path=/; HttpOnly; SameSite=None; Secure; Partitioned; Max-Age=${Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))}`,
  ];
}

/** Native ingress may force HTML downloads. Inline only its bare attachment header
 * on the isolated preview site; keep named downloads and other media untouched. */
export function previewContentDisposition(transport, contentType, disposition) {
  const mime = String(contentType ?? '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  return transport === 'native' &&
    ['text/html', 'application/xhtml+xml'].includes(mime) &&
    String(disposition ?? '')
      .trim()
      .toLowerCase() === 'attachment'
    ? 'inline'
    : disposition;
}

/** Validate the server-authenticated descriptor, not a browser-supplied destination. */
export function validatePreviewTarget(target) {
  const url = new URL(target.url);
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !Number.isFinite(target.expiresAt) ||
    target.expiresAt <= Date.now()
  )
    throw new Error('Invalid preview target');
  if (target.transport === 'native') {
    const token = target.headers?.['e2b-traffic-access-token'];
    if (
      url.protocol !== 'https:' ||
      !url.hostname ||
      typeof token !== 'string' ||
      !token ||
      token.length > 8192 ||
      /[\r\n]/.test(token) ||
      Object.keys(target.headers).some((k) => k !== 'e2b-traffic-access-token')
    )
      throw new Error('Invalid protected native preview');
  } else if (target.transport === 'sdk') {
    const port = Number(url.port);
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      !Number.isInteger(port) ||
      port < 1024 ||
      port > 65535 ||
      port === 49983 ||
      target.headers
    )
      throw new Error('Invalid SDK preview target');
  } else throw new Error('Unknown preview transport');
}
