/**
 * What a token plan's vendor reports about the account behind a key: the
 * quota left and, where the vendor says, which capabilities the plan's tier
 * does not include. The server asks the vendor (lib/server/plan-status); the
 * settings only show the answer. Client-safe types.
 */
import type { SlotCapability } from '@/lib/config/model-slots';

/** One metered window of a plan's quota. */
export interface PlanQuotaWindow {
  /**
   * What the window meters when not the whole plan: a capability metered on
   * its own (`video`), or the vendor's own name for a category it reads as
   * neither.
   */
  category?: string;
  /** A rolling window of `hours`, or a weekly or monthly allowance. */
  period: 'hours' | 'week' | 'month';
  hours?: number;
  /** Share of the window left, 0–100; a boosted plan may report more than 100. */
  remainingPercent?: number;
  /** Counted calls, when the vendor reports them. */
  used?: number;
  total?: number;
  /** The window has no limit. */
  unlimited?: boolean;
  /** When the window resets (ISO 8601), when the vendor reports it. */
  resetsAt?: string;
}

/** A prepaid balance in one currency (a pay-as-you-go account). */
export interface PlanBalance {
  currency: string;
  /** As the vendor reports it, a decimal string. */
  amount: string;
}

export type PlanQuota =
  | { status: 'available'; windows: PlanQuotaWindow[]; balances: PlanBalance[] }
  /** The vendor offers no query for this plan, or it did not answer. */
  | { status: 'unavailable' };

export interface PlanStatus {
  quota: PlanQuota;
  /**
   * Capabilities the vendor confirmed the account's plan does not include.
   * Absent when the vendor does not say (or could not be asked): the plan's
   * declared capabilities then stand.
   */
  unsupported?: SlotCapability[];
}
