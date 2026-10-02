/**
 * Whether the app's own cookies (the anonymous owner cookie and the
 * ACCESS_CODE cookie) carry `Secure`. Production sets it by default;
 * plain-HTTP deployments opt out with the exact value COOKIE_SECURE=0
 * (browsers keep a `Secure` cookie only over HTTPS or on localhost, and Safari
 * not even there, so without the opt-out every request mints a fresh owner and
 * the access code is asked for again).
 */
export function cookiesAreSecure(): boolean {
  return process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== '0';
}
