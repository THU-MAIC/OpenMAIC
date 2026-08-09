/**
 * Static meta-refresh redirect to the getting-started page. `redirect()` cannot
 * run in a fully static export, so each locale index ships HTML that bounces the
 * browser instead.
 */
export function IndexRedirect({ target }: { target: string }) {
  return (
    <>
      <meta httpEquiv="refresh" content={`0; url=${target}`} />
      <script
        dangerouslySetInnerHTML={{
          __html: `location.replace(${JSON.stringify(target)})`,
        }}
      />
      <p style={{ padding: '2rem' }}>
        Redirecting to <a href={target}>{target}</a>…
      </p>
    </>
  );
}
