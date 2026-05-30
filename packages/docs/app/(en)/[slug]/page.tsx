import { source } from '@/lib/source';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { RenderDocsPage } from '@/components/docs-page';
import { i18n } from '@/lib/i18n';

// Default-locale docs page at /docs/<slug> (no /en prefix).
export default async function Page(props: PageProps<'/[slug]'>) {
  const { slug } = await props.params;
  return <RenderDocsPage slug={[slug]} lang={i18n.defaultLanguage} />;
}

export function generateStaticParams() {
  // Only the default-locale pages, as single-segment slugs.
  return source
    .getPages(i18n.defaultLanguage)
    .map((page) => ({ slug: page.slugs.join('/') }));
}

export async function generateMetadata(
  props: PageProps<'/[slug]'>,
): Promise<Metadata> {
  const { slug } = await props.params;
  const page = source.getPage([slug], i18n.defaultLanguage);
  if (!page) notFound();
  return { title: page.data.title, description: page.data.description };
}
