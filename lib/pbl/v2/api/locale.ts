import type { NextRequest } from 'next/server';

import { supportedLocales } from '@/lib/i18n/locales';
import type { PBLProjectV2 } from '../types';

const supportedLocaleCodes = new Set<string>(supportedLocales.map((locale) => locale.code));

/** Sync `project.language` (BCP-47 fallback locale) with the user's
 *  UI language. Does NOT touch `project.languageDirective` — the
 *  classroom's content-language policy is authoritative for all
 *  Planner / Instructor / Evaluator content and is never overwritten
 *  by the UI locale header.
 *
 *  Route-level sync closes the timing gap where the user clicks into
 *  PBL before the Hero's client-side locale effect has published the
 *  updated project. */
export function applyRequestLocaleToProject(req: NextRequest, project: PBLProjectV2): void {
  const locale = req.headers.get('x-user-locale')?.trim();
  if (!locale || !supportedLocaleCodes.has(locale)) return;
  project.language = locale;
}
