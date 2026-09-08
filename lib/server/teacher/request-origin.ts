interface OriginPolicy {
  requireOrigin?: boolean;
  requireBrowserEvidence?: boolean;
}

function requestOrigin(req: Request): string | undefined {
  try {
    const url = new URL(req.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    const host = req.headers.get('host');
    if (host === null) return url.origin;
    if (host.length === 0 || /[\s\\/?#@,]/u.test(host)) return undefined;
    // NextURL rewrites loopback hostnames to localhost; Host retains the browser's authority.
    return new URL(`${url.protocol}//${host}`).origin;
  } catch {
    return undefined;
  }
}

export function isSameOriginTeacherRequest(req: Request, policy: OriginPolicy = {}): boolean {
  const fetchSite = req.headers.get('sec-fetch-site');
  if (fetchSite !== null && fetchSite !== 'same-origin') return false;
  const expected = requestOrigin(req);
  if (!expected) return false;
  const origin = req.headers.get('origin');
  if (origin !== null) return origin === expected;
  return !policy.requireOrigin && (!policy.requireBrowserEvidence || fetchSite === 'same-origin');
}
