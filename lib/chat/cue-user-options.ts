import type { CueUserOption } from '@/lib/types/chat';

/** Legacy strings remain ordinary replies; only an explicit action can stop. */
export function cueUserOptionLabel(option: CueUserOption): string {
  return typeof option === 'string' ? option : option.label;
}

export function normalizeCueUserOptions(options?: CueUserOption[]): CueUserOption[] | undefined {
  const seen = new Set<string>();
  const normalized = options
    ?.flatMap((option) => {
      const label = cueUserOptionLabel(option).trim().slice(0, 60);
      if (!label || seen.has(label)) return [];
      seen.add(label);
      return [
        typeof option === 'string'
          ? label
          : {
              label,
              ...(option.action === 'end_discussion' ? { action: option.action } : {}),
            },
      ];
    })
    .slice(0, 4);
  return normalized && normalized.length >= 2 ? normalized : undefined;
}
