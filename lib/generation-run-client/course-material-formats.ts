import { getFormatLabelsForProviders } from '@/lib/document/mime';

export type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * The formats the active extractors accept, as a localized list ("PDF, TXT,
 * MD"). The format labels are file-type names shared by every locale; only
 * the separator is localized.
 */
export function courseMaterialFormatList(t: Translate, providerIds: readonly string[]): string {
  return getFormatLabelsForProviders(providerIds).join(t('upload.formatListSeparator'));
}

/** The "this file type is unsupported" message, naming the extractor and what it accepts. */
export function unsupportedCourseMaterialMessage(
  t: Translate,
  extractorName: string,
  providerIds: readonly string[],
): string {
  return t('upload.unsupportedCourseMaterial', {
    parser: extractorName,
    formats: courseMaterialFormatList(t, providerIds),
  });
}
