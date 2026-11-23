'use client';

import { useEffect, useState } from 'react';
import { PBLV3Workspace } from '@/components/scene-renderers/pbl/v3/workspace';
import { I18nProvider } from '@/lib/hooks/use-i18n';
import { useStageStore } from '@/lib/store/stage';
import english from '@/lib/i18n/locales/en-US.json';

export default function VoiceReview() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    useStageStore.setState({
      stage: { id: 'voice-example', name: 'Greeting', createdAt: 0, updatedAt: 0 },
    });
    setReady(true);
  }, []);
  return (
    <I18nProvider initialLocale="en-US" initialResources={english}>
      <main style={{ height: '100dvh' }}>
        {ready && <PBLV3Workspace sceneId="voice-example-scene" />}
      </main>
    </I18nProvider>
  );
}
