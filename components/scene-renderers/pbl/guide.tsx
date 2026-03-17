'use client';

import { HelpCircle } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card';

/**
 * Inline guide shown below the role selection cards.
 * Hover to reveal the 3-step PBL workflow as a popover above.
 */
export function PBLGuideInline() {
  const { t } = useI18n();

  return (
    <HoverCard openDelay={0} closeDelay={150}>
      <div className="w-full flex justify-center">
        <HoverCardTrigger asChild>
          <button className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
            <HelpCircle className="w-4 h-4" />
            <span>{t('pbl.guide.howItWorks')}</span>
          </button>
        </HoverCardTrigger>
      </div>
      <HoverCardContent
        side="top"
        collisionPadding={16}
        className="w-[380px] overflow-y-auto rounded-xl p-5"
        style={{
          maxHeight: 'var(--radix-hover-card-content-available-height, 70vh)',
        }}
      >
        <GuideContent />
      </HoverCardContent>
    </HoverCard>
  );
}

/**
 * Help button in workspace toolbar — hover to show guide popover.
 */
export function PBLGuidePanel() {
  const { t } = useI18n();

  return (
    <HoverCard openDelay={0} closeDelay={150}>
      <HoverCardTrigger asChild>
        <button
          className="flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          title={t('pbl.guide.help')}
        >
          <HelpCircle className="w-4 h-4" />
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        side="bottom"
        align="end"
        collisionPadding={16}
        className="w-[380px] overflow-y-auto rounded-xl p-5"
        style={{
          maxHeight: 'var(--radix-hover-card-content-available-height, 80vh)',
        }}
      >
        <GuideContent />
      </HoverCardContent>
    </HoverCard>
  );
}

function GuideContent() {
  const { t } = useI18n();

  return (
    <div className="space-y-5 text-[13px] leading-relaxed text-foreground">
      {/* Step 1 */}
      <section>
        <h4 className="font-semibold mb-1">{t('pbl.guide.step1.title')}</h4>
        <p className="text-muted-foreground">{t('pbl.guide.step1.desc')}</p>
      </section>

      <hr className="border-border" />

      {/* Step 2 */}
      <section>
        <h4 className="font-semibold mb-1">{t('pbl.guide.step2.title')}</h4>
        <p className="text-muted-foreground mb-3">{t('pbl.guide.step2.desc')}</p>

        <ol className="list-decimal list-inside space-y-3 text-muted-foreground">
          {/* 2-1 */}
          <li>
            <span className="font-medium text-foreground">{t('pbl.guide.step2.s1.title')}</span>
            <p className="mt-0.5 ml-[1.125rem]">{t('pbl.guide.step2.s1.desc')}</p>
          </li>

          {/* 2-2 */}
          <li>
            <span className="font-medium text-foreground">{t('pbl.guide.step2.s2.title')}</span>
            <code className="ml-1.5 text-xs bg-muted rounded px-1.5 py-0.5 font-mono">
              @question
            </code>
            <div className="mt-1.5 ml-[1.125rem] space-y-1.5">
              <pre className="text-xs bg-muted/70 rounded-md px-3 py-2 font-mono leading-relaxed overflow-x-auto">
                {t('pbl.guide.step2.s2.example')}
              </pre>
              <p>{t('pbl.guide.step2.s2.desc')}</p>
            </div>
          </li>

          {/* 2-3 */}
          <li>
            <span className="font-medium text-foreground">{t('pbl.guide.step2.s3.title')}</span>
            <code className="ml-1.5 text-xs bg-muted rounded px-1.5 py-0.5 font-mono">@judge</code>
            <div className="mt-1.5 ml-[1.125rem] space-y-1.5">
              <pre className="text-xs bg-muted/70 rounded-md px-3 py-2 font-mono leading-relaxed overflow-x-auto">
                {t('pbl.guide.step2.s3.example')}
              </pre>
              <p>{t('pbl.guide.step2.s3.desc')}</p>
              <ul className="space-y-0.5 mt-1">
                <li>
                  ✅ <span className="font-medium text-foreground">COMPLETE</span> →{' '}
                  {t('pbl.guide.step2.s3.complete')}
                </li>
                <li>
                  🔄 <span className="font-medium text-foreground">NEEDS_REVISION</span> →{' '}
                  {t('pbl.guide.step2.s3.revision')}
                </li>
              </ul>
            </div>
          </li>
        </ol>
      </section>

      <hr className="border-border" />

      {/* Step 3 */}
      <section>
        <h4 className="font-semibold mb-1">{t('pbl.guide.step3.title')}</h4>
        <p className="text-muted-foreground">{t('pbl.guide.step3.desc')}</p>
      </section>
    </div>
  );
}
