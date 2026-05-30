import { IndexRedirect } from '@/components/index-redirect';

// /docs/ -> /docs/getting-started (default locale).
export default function HomePage() {
  return <IndexRedirect target="/docs/getting-started" />;
}
