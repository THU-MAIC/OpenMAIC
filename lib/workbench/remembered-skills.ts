/**
 * The skills last seen, kept across reloads so a handle already drawn as a chip
 * does not start as text and jump when the list answers. Only for the wait: once
 * the registry has answered, it alone says what resolves. Owner-scoped like the
 * registry, so it goes when the owner changes.
 */
const REMEMBERED_SKILLS_KEY = 'openmaic:workbench:skill-names';

export interface RememberedSkill {
  readonly name: string;
  readonly title?: string | null;
  readonly source?: string;
}

export function readRememberedSkills(): readonly RememberedSkill[] {
  try {
    const stored = JSON.parse(globalThis.localStorage?.getItem(REMEMBERED_SKILLS_KEY) ?? '[]');
    return Array.isArray(stored) ? (stored as RememberedSkill[]) : [];
  } catch {
    return [];
  }
}

export function rememberSkills(skills: readonly RememberedSkill[]): void {
  try {
    globalThis.localStorage?.setItem(
      REMEMBERED_SKILLS_KEY,
      JSON.stringify(skills.map(({ name, title, source }) => ({ name, title, source }))),
    );
  } catch {
    // Storage refused: the wait is a little less tidy, nothing more.
  }
}

export function forgetRememberedSkills(): void {
  try {
    globalThis.localStorage?.removeItem(REMEMBERED_SKILLS_KEY);
  } catch {
    // As above.
  }
}
