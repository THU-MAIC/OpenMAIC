'use client';

import { useEffect, useMemo } from 'react';

import { defaultWorkbenchTranslator, type WorkbenchTranslator } from '@/lib/i18n/workbench';

import { skillTitle, useAgentSkills } from './agent-skills';
import { readRememberedSkills, rememberSkills, type RememberedSkill } from './remembered-skills';

/**
 * The installed skills by handle, with the name each is shown under: what makes
 * `/handle` a chip, in the composer and in a sent message alike. While the
 * registry has not answered, the skills remembered from last time stand in.
 */
export function useSkillChipNames(
  t: WorkbenchTranslator = defaultWorkbenchTranslator,
): ReadonlyMap<string, string> {
  const { skills, loading, error } = useAgentSkills();
  const answered = !loading && !error;
  useEffect(() => {
    if (answered) rememberSkills(skills);
  }, [answered, skills]);
  return useMemo(() => {
    const list: readonly RememberedSkill[] = answered ? skills : readRememberedSkills();
    return new Map(list.map((skill) => [skill.name, skillTitle(skill, t) ?? skill.name]));
  }, [answered, skills, t]);
}
