'use client';

import { ArrowLeft } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useRouter } from 'next/navigation';
import type { StageMode } from '@/lib/types/stage';
import { HeaderControls } from './stage/header-controls';
import { Progress } from '@/components/ui/progress';

interface HeaderProps {
  readonly currentSceneTitle: string;
  readonly mode?: StageMode;
  readonly canEdit?: boolean;
  readonly onToggleEditMode?: () => void;
  readonly currentSceneIndex?: number;
  readonly scenesCount?: number;
}

export function Header({
  currentSceneTitle,
  mode,
  canEdit,
  onToggleEditMode,
  currentSceneIndex = 0,
  scenesCount = 0,
}: HeaderProps) {
  const { t } = useI18n();
  const router = useRouter();

  return (
    <>
      <header className="relative h-20 px-8 flex items-center justify-between z-10 bg-transparent gap-4">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <button
            onClick={() => router.push('/')}
            className="shrink-0 p-2 rounded-lg text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
            title={t('generation.backToHome')}
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          {/* Title block — hidden when `mode === 'edit'`. Header lives
              inside `PlaybackChromeRoot`, which is unmounted by `Stage`
              once mode flips to 'edit', so in steady state this branch
              is always taken. The guard exists for the ~280ms
              AnimatePresence exit window where the playback chrome
              is still rendering its exit animation while `mode` has
              already flipped — without the guard, this title would
              briefly stack on top of the incoming EditChromeRoot's
              CommandBar title during the cross-fade. */}
          {mode !== 'edit' && (
            <div className="flex flex-col min-w-0">
              <span className="text-[10px] uppercase tracking-widest font-bold text-gray-400 dark:text-gray-500 mb-0.5">
                {t('stage.currentScene')}
              </span>
              <h1
                className="text-xl font-bold text-gray-800 dark:text-gray-200 tracking-tight truncate"
                suppressHydrationWarning
              >
                {currentSceneTitle || t('common.loading')}
              </h1>
            </div>
          )}
        </div>

        <HeaderControls mode={mode} canEdit={canEdit} onToggleEditMode={onToggleEditMode} />
        {scenesCount > 0 && (
          <div className="absolute inset-x-8 bottom-0 flex items-center gap-2">
            <Progress
              value={Math.min(100, Math.max(0, ((currentSceneIndex + 1) / scenesCount) * 100))}
              className="h-1 flex-1 bg-gray-200/70 dark:bg-gray-700/70"
              aria-label={`Learning progress: ${Math.min(scenesCount, Math.max(0, currentSceneIndex + 1))} of ${scenesCount}`}
            />
            <span className="text-[10px] tabular-nums text-gray-400 dark:text-gray-500 select-none">
              {Math.min(scenesCount, Math.max(0, currentSceneIndex + 1))}/{scenesCount}
            </span>
          </div>
        )}
      </header>
    </>
  );
}
