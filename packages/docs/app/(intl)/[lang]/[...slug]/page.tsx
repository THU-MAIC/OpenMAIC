import { source } from '@/lib/source';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { RenderDocsPage } from '@/components/docs-page';
import { i18n } from '@/lib/i18n';

// Prefixed-locale docs page at /docs/<lang>/<slug> (requires >=1 slug segment,
// so it never collides with the default-locale single-segment /[slug] route).
export default async function Page(props: PageProps<'/[lang]/[...slug]'>) {
  const { lang, slug } = await props.params;
  return <RenderDocsPage slug={slug} lang={lang} />;
}

export function generateStaticParams() {
  // Every NON-default locale × every slug.
  const langs = i18n.languages.filter((l) => l !== i18n.defaultLanguage);
  const params: { lang: string; slug: string[] }[] = [];
  for (const lang of langs) {
    for (const page of source.getPages(lang)) {
      params.push({ lang, slug: page.slugs });
    }
  }
  return params;
}

export async function generateMetadata(
  props: PageProps<'/[lang]/[...slug]'>,
): Promise<Metadata> {
  const { lang, slug } = await props.params;
  const page = source.getPage(slug, lang);
  if (!page) notFound();
  return { title: page.data.title, description: page.data.description };
}
