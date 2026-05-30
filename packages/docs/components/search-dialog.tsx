'use client';
import { useI18n } from 'fumadocs-ui/contexts/i18n';
import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogFooter,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
} from 'fumadocs-ui/components/dialog/search';
import type { SharedProps } from 'fumadocs-ui/contexts/search';
import { useDocsSearch } from 'fumadocs-core/search/client';
import { create } from '@orama/orama';

// Map each docs locale to an Orama-supported tokenizer language. MUST match the
// build-time localeMap in app/static.json/route.ts, because the static client
// re-creates one Orama DB per locale partition and Orama rejects unknown
// languages like "zh-cn"/"ja".
const ORAMA_LANGUAGE: Record<string, string> = {
  en: 'english',
  'zh-cn': 'english',
  'zh-tw': 'english',
  ja: 'english',
  ru: 'russian',
  ar: 'arabic',
};

// Where the static Orama index is served (basePath '/docs' + the route).
const STATIC_API = '/docs/static.json';

export default function StaticSearchDialog(props: SharedProps) {
  const { locale } = useI18n();
  const { search, setSearch, query } = useDocsSearch({
    type: 'static',
    from: STATIC_API,
    locale,
    initOrama: (loc) =>
      create({
        schema: { _: 'string' },
        language: ORAMA_LANGUAGE[loc ?? 'en'] ?? 'english',
      }),
  });

  return (
    <SearchDialog
      search={search}
      onSearchChange={setSearch}
      isLoading={query.isLoading}
      {...props}
    >
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput />
          <SearchDialogClose />
        </SearchDialogHeader>
        <SearchDialogList items={query.data !== 'empty' ? query.data : null} />
      </SearchDialogContent>
      <SearchDialogFooter />
    </SearchDialog>
  );
}
