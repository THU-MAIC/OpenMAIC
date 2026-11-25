'use client';

// What a token plan gives the workspace, one card per capability: whether
// the plan (this connection of it) offers it, and which service the
// capability's default (its root slot) resolves to now. The two are read
// apart: a plan can offer a capability another service serves by default.

import {
  Check,
  CircleAlert,
  FileText,
  Globe,
  Image as ImageIcon,
  MessageSquare,
  Minus,
  Mic,
  Search,
  Video,
  Volume2,
  type LucideIcon,
} from 'lucide-react';
import type { SlotCapability } from '@/lib/config/model-slots';
import type { TokenPlanModality, TokenPlanPreset } from '@/lib/config/token-plan-presets';
import type { ModelSettingsView, ProviderView } from '@/lib/model-settings/client';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';

const tp = 'settings.tokenPlan';

/** The capabilities shown as cards, with the root slot whose default each one names. */
export const CARD_CAPABILITIES: ReadonlyArray<{
  capability: SlotCapability;
  modality: TokenPlanModality;
  label: string;
  /** The name on the card and in the plan list; `label` is the full one. */
  short: string;
  icon: LucideIcon;
}> = [
  {
    capability: 'chat',
    modality: 'llm',
    label: `${tp}.capLlm`,
    short: `${tp}.capLlmShort`,
    icon: MessageSquare,
  },
  {
    capability: 'image',
    modality: 'image',
    label: `${tp}.capImage`,
    short: `${tp}.capImageShort`,
    icon: ImageIcon,
  },
  {
    capability: 'video',
    modality: 'video',
    label: `${tp}.capVideo`,
    short: `${tp}.capVideoShort`,
    icon: Video,
  },
  {
    capability: 'tts',
    modality: 'tts',
    label: `${tp}.capTts`,
    short: `${tp}.capTtsShort`,
    icon: Volume2,
  },
  {
    capability: 'webSearch',
    modality: 'webSearch',
    label: `${tp}.capWebSearch`,
    short: `${tp}.capWebSearchShort`,
    icon: Search,
  },
  {
    capability: 'webFetch',
    modality: 'webFetch',
    label: `${tp}.capWebFetch`,
    short: `${tp}.capWebFetchShort`,
    icon: Globe,
  },
];

/** Capabilities a plan may also cover that have no card of their own. */
const EXTRA_CAPABILITIES: ReadonlyArray<{ modality: 'asr' | 'document'; label: string }> = [
  { modality: 'asr', label: `${tp}.capAsr` },
  { modality: 'document', label: `${tp}.capDocument` },
];

/** What the root slot of a capability's slot tree is the root slot id of. */
const ROOT_SLOT: Record<SlotCapability, string> = {
  chat: 'llm',
  image: 'image',
  video: 'video',
  tts: 'tts',
  asr: 'asr',
  document: 'document',
  webSearch: 'webSearch',
  webFetch: 'webFetch',
};

/**
 * Whether the plan offers a capability:
 * - `included`: it does (on this connection, when connected);
 * - `not-in-tier`: the vendor reported the key's account does not have it;
 * - `unavailable`: the plan declares it, but this connection does not serve
 *   it (the deployment switched it off, or a custom endpoint cannot);
 * - `not-offered`: the plan does not declare it.
 */
export type PlanOffer = 'included' | 'not-in-tier' | 'unavailable' | 'not-offered';

/** Where the capability's default (its root slot's own target, not a fallback) goes now. */
export type DefaultRoute =
  | { kind: 'this'; modelId?: string }
  | { kind: 'other'; providerId: string; modelId?: string }
  | { kind: 'off' }
  | { kind: 'unset' }
  | { kind: 'invalid' };

export interface CapabilityCardState {
  capability: SlotCapability;
  offer: PlanOffer;
  route: DefaultRoute;
  /** Course stages set to this connection on their own (chat). */
  stageRoutes: number;
}

export function planCapabilityStates(
  view: ModelSettingsView,
  plan: TokenPlanPreset,
  provider: ProviderView | undefined,
): CapabilityCardState[] {
  return CARD_CAPABILITIES.map(({ capability, modality }) => {
    const offer: PlanOffer = !plan.modalities[modality]
      ? 'not-offered'
      : !provider
        ? 'included'
        : provider.unsupportedCapabilities?.includes(capability)
          ? 'not-in-tier'
          : provider.capabilities[capability]
            ? 'included'
            : 'unavailable';
    const effective = view.slots.find((slot) => slot.slot === ROOT_SLOT[capability])?.effective;
    const route: DefaultRoute =
      !effective || effective.status === 'unassigned'
        ? { kind: 'unset' }
        : effective.status === 'disabled'
          ? { kind: 'off' }
          : effective.status === 'invalid'
            ? { kind: 'invalid' }
            : provider && effective.providerId === provider.id
              ? { kind: 'this', modelId: effective.modelId }
              : { kind: 'other', providerId: effective.providerId, modelId: effective.modelId };
    const stageRoutes =
      capability === 'chat' && provider
        ? view.slots.filter(
            (slot) =>
              slot.capability === 'chat' &&
              slot.slot !== 'llm' &&
              slot.effective.status === 'assigned' &&
              slot.effective.resolvedAt === slot.slot &&
              slot.effective.providerId === provider.id,
          ).length
        : 0;
    return { capability, offer, route, stageRoutes };
  });
}

/** The models a plan declares for a modality, best first. */
export function planModels(plan: TokenPlanPreset, modality: TokenPlanModality): string[] {
  const target = plan.modalities[modality];
  if (!target) return [];
  if (target.defaultModels?.length) return target.defaultModels;
  if (target.defaultModelId) return [target.defaultModelId];
  return [];
}

export function PlanCapabilities({
  view,
  plan,
  provider,
  name,
  serviceName,
}: {
  view: ModelSettingsView;
  plan: TokenPlanPreset;
  /** The connection the cards describe; none for a plan not connected yet. */
  provider: ProviderView | undefined;
  name: string;
  /** How a service is named on a card (another connection, plan or provider). */
  serviceName: (providerId: string, withRank?: boolean) => string;
}) {
  const { t } = useI18n();
  const states = planCapabilityStates(view, plan, provider);
  const included = states.filter((state) => state.offer === 'included').length;
  const serving = states.filter(
    (state) => state.offer === 'included' && state.route.kind === 'this',
  ).length;
  const extras = EXTRA_CAPABILITIES.filter(
    ({ modality }) => plan.modalities[modality] && (!provider || provider.capabilities[modality]),
  );

  // A capability without a model (search) is named after the plan: "MiniMax search".
  const planTarget = (state: CapabilityCardState) =>
    state.capability === 'webSearch' ? t(`${tp}.searchBy`, { name }) : undefined;

  const routeText = (state: CapabilityCardState, modality: TokenPlanModality): string => {
    if (!provider) {
      // Not connected: what the plan would set up by default.
      const models = planModels(plan, modality);
      const lead = plan.modalities[modality]?.defaultModelId ?? models[0];
      if (!lead) return planTarget(state) ?? t(`${tp}.capViaPlan`, { name });
      return models.length > 1
        ? `${lead} ${t(`${tp}.moreModels`, { n: models.length - 1 })}`
        : lead;
    }
    const { route } = state;
    if (route.kind === 'off') return t(`${tp}.routeOff`);
    if (route.kind === 'unset') return t(`${tp}.routeUnset`);
    if (route.kind === 'invalid') return t(`${tp}.routeInvalid`);
    // A model is named by its id, as in the plan's model list.
    if (route.kind === 'this') {
      const target = route.modelId ?? planTarget(state) ?? name;
      const stages = state.stageRoutes
        ? ` ${t(`${tp}.stageRoutes`, { n: state.stageRoutes })}`
        : '';
      return t(`${tp}.routeDefault`, { target: `${target}${stages}` });
    }
    // Served elsewhere: the card names the service; its model is on that plan's page.
    // "Handled by" names it alone, as in the mockup, which keeps the card to one line.
    return state.offer === 'included'
      ? t(`${tp}.routeOther`, { target: serviceName(route.providerId) })
      : t(`${tp}.routeHandledBy`, { target: serviceName(route.providerId, false) });
  };

  return (
    <section className="@container space-y-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h5 className="text-[13px] font-semibold">
          {t(provider ? `${tp}.capsTitle` : `${tp}.capsTitlePreview`)}
        </h5>
        <span className="text-xs text-muted-foreground">
          {provider
            ? t(`${tp}.capsCount`, { serving, included, total: states.length })
            : t(`${tp}.capsCountPreview`, { included, total: states.length })}
        </span>
      </div>
      {/* Three across once the cards can hold a name beside its badge (about 42rem), as in the mockup. */}
      <ul className="grid gap-1.5 @sm:grid-cols-2 @2xl:grid-cols-3">
        {states.map((state) => {
          const card = CARD_CAPABILITIES.find((entry) => entry.capability === state.capability)!;
          const Icon = card.icon;
          const active = !!provider && state.offer === 'included' && state.route.kind === 'this';
          const badge =
            state.offer === 'not-in-tier'
              ? { text: t(`${tp}.capNotInTier`), icon: CircleAlert, tone: 'warn' as const }
              : state.offer === 'unavailable'
                ? { text: t(`${tp}.capUnavailable`), icon: Minus, tone: 'muted' as const }
                : state.offer === 'not-offered'
                  ? { text: t(`${tp}.capNotOffered`), icon: Minus, tone: 'muted' as const }
                  : active
                    ? { text: t(`${tp}.capActive`), icon: Check, tone: 'ok' as const }
                    : { text: t(`${tp}.capIncluded`), icon: Check, tone: 'brand' as const };
          const BadgeIcon = badge.icon;
          // A capability the plan does not offer names who serves it, when someone does.
          const handledElsewhere = !!provider && state.route.kind === 'other';
          const detail =
            state.offer === 'not-in-tier'
              ? t(`${tp}.notInTierReason`, { name })
              : state.offer === 'unavailable'
                ? t(`${tp}.unavailableReason`)
                : state.offer === 'not-offered'
                  ? handledElsewhere
                    ? routeText(state, card.modality)
                    : t(`${tp}.notOfferedBy`, { name })
                  : routeText(state, card.modality);
          return (
            <li
              key={state.capability}
              className={cn(
                'min-w-0 space-y-1.5 rounded-xl border px-3.5 py-3',
                badge.tone === 'warn'
                  ? 'border-orange-200 bg-orange-50 dark:border-orange-900/70 dark:bg-orange-950/30'
                  : badge.tone === 'muted'
                    ? 'bg-muted/40'
                    : 'bg-background',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className={cn(
                    'flex min-w-0 items-center gap-2 text-[13px] font-medium',
                    badge.tone === 'muted' && 'text-muted-foreground',
                  )}
                >
                  <span
                    className={cn(
                      'flex size-6 shrink-0 items-center justify-center rounded-md',
                      badge.tone === 'warn'
                        ? 'bg-orange-100 text-orange-600 dark:bg-orange-900/40 dark:text-orange-300'
                        : badge.tone === 'muted'
                          ? 'bg-muted text-muted-foreground'
                          : 'bg-primary/10 text-primary',
                    )}
                    aria-hidden="true"
                  >
                    <Icon className="size-3.5" />
                  </span>
                  <span className="truncate" title={t(card.label)}>
                    {t(card.short)}
                  </span>
                </span>
                <span
                  className={cn(
                    'flex shrink-0 items-center gap-1 text-[11px] font-medium',
                    badge.tone === 'ok' && 'text-green-700 dark:text-green-400',
                    badge.tone === 'brand' && 'text-primary',
                    badge.tone === 'warn' && 'text-orange-700 dark:text-orange-300',
                    badge.tone === 'muted' && 'text-muted-foreground',
                  )}
                >
                  {BadgeIcon && <BadgeIcon className="size-3" aria-hidden="true" />}
                  {badge.text}
                </span>
              </div>
              <p
                className={cn(
                  'break-words text-xs leading-4',
                  badge.tone === 'warn'
                    ? 'text-orange-700 dark:text-orange-300'
                    : 'text-muted-foreground',
                )}
              >
                {detail}
              </p>
            </li>
          );
        })}
      </ul>
      {extras.length > 0 && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {extras.some(({ modality }) => modality === 'document') ? (
            <FileText className="size-3.5" aria-hidden="true" />
          ) : (
            <Mic className="size-3.5" aria-hidden="true" />
          )}
          {t(`${tp}.alsoProvides`, {
            list: extras.map(({ label }) => t(label)).join(t(`${tp}.listSeparator`)),
          })}
        </p>
      )}
    </section>
  );
}
