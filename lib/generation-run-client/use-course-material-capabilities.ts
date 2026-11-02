'use client';

import { useEffect, useMemo } from 'react';
import { useModelCapabilities } from '@/lib/model-settings/use-model-settings';
import { useI18n } from '@/lib/hooks/use-i18n';
import { isMimeSupportedByProviders } from '@/lib/document/mime';
import { PDF_PROVIDERS } from '@/lib/pdf/constants';
import type { PDFProviderId } from '@/lib/pdf/types';
import type { CourseMaterialEntry } from './use-course-materials';
import { unsupportedCourseMaterialMessage } from './course-material-formats';

/** Keep provider validation alive even when a phone's course-options toolbar is closed. */
export function useCourseMaterialCapabilities(
  materials: readonly CourseMaterialEntry[],
  remove: (id: string) => void,
  onError: (message: string) => void,
  locked = false,
) {
  const { t } = useI18n();
  const { document, known } = useModelCapabilities();
  const providerId = (document?.registryId ?? 'unpdf') as PDFProviderId;
  const providers = useMemo(() => [providerId, 'plain-text'], [providerId]);
  useEffect(() => {
    if (locked || !known) return;
    const unsupported = materials.filter(
      (file) =>
        !isMimeSupportedByProviders({ mimeType: file.type, fileName: file.name }, providers),
    );
    if (!unsupported.length) return;
    for (const file of unsupported) remove(file.id);
    onError(
      unsupportedCourseMaterialMessage(t, PDF_PROVIDERS[providerId]?.name ?? providerId, providers),
    );
  }, [materials, providers, providerId, remove, onError, locked, known, t]);
}
