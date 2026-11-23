import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import type { LearningView } from '@/lib/pbl/v3/types';

export function TeachingExit({
  view,
  nextLabel,
  disabled,
  onNext,
  onAsk,
}: {
  view: LearningView;
  nextLabel: string;
  disabled: boolean;
  onNext: () => void;
  onAsk: (text: string) => void;
}) {
  const { t } = useI18n();
  const concepts = view.milestones?.[view.state.position.milestoneIndex]?.concepts;
  const more = t('pblV3.journey.explainMore');
  return (
    <section
      className="pointer-events-auto w-full space-y-2 rounded-lg border bg-background p-2 text-xs"
      aria-label={nextLabel}
    >
      {!!concepts?.length && <p className="text-muted-foreground">{concepts.join(' · ')}</p>}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onAsk(more)}
          className="rounded-md border px-3 py-2 disabled:opacity-50"
        >
          {more}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={onNext}
          className={cn(
            'rounded-md border px-3 py-2 font-semibold disabled:opacity-50',
            !!view.teachingVisit?.learnerTurns && 'bg-primary text-primary-foreground',
          )}
        >
          {nextLabel}
        </button>
      </div>
    </section>
  );
}
