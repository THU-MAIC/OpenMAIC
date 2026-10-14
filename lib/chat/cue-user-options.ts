/** Trim, deduplicate and bound the optional labels suggested by cue_user. */
export function normalizeCueUserOptions(options?: string[]): string[] | undefined {
  const seen = new Set<string>();
  const normalized = options
    ?.flatMap((option) => {
      if (typeof option !== 'string') return [];
      const label = option.trim().slice(0, 60);
      if (!label || seen.has(label)) return [];
      seen.add(label);
      return [label];
    })
    .slice(0, 4);
  return normalized && normalized.length >= 2 ? normalized : undefined;
}
