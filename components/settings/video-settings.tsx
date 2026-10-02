'use client';

import { VIDEO_PROVIDERS } from '@/lib/media/video-providers';
import type { VideoProviderId } from '@/lib/media/types';
import { MediaServicePanel } from './media-service-panel';
import type { ServicePanelProps } from './server-settings';

/** A video generation service (see MediaServicePanel). */
export function VideoSettings(props: ServicePanelProps) {
  const registry = VIDEO_PROVIDERS[props.entry.registryId as VideoProviderId];
  return (
    <MediaServicePanel
      {...props}
      kind="video"
      defaultBaseUrl={registry?.defaultBaseUrl}
      catalogue={registry?.models ?? []}
    />
  );
}
