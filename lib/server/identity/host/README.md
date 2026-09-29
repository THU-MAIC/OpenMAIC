# Host auth methods

This directory is where a deployment keeps its own owner auth methods (see
"Owner identity" in the repository README): a session cookie, an API key, or
a gateway-signed token such as the README's JWT recipe. OpenMAIC ships nothing
here.

It is the only place outside core that may read identity headers: the
boundary test (`tests/server/identity/cookie-guard.test.ts`) fails on gateway
identity headers (`cf-access-*`, `x-goog-iap-jwt-assertion`,
`x-forwarded-user`, ...) and on reads of an incoming `Authorization` header
anywhere else, including the rest of `lib/server/identity/`. Code here uses
the public surface (`@/lib/server/identity`), not the resolution internals.

Register the methods from `instrumentation.ts` with
`configureOwnerAuthentication({ methods: [...] })`.

The middleware mints the anonymous owner cookie on page navigations
(`anonymousOwnerForNavigation` in `middleware.ts`, see `../navigation.ts`); it
cannot see these registrations. Skip it there for requests your methods own if
you do not want an anonymous cookie next to your credential.
