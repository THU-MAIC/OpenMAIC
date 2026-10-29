import 'server-only';
import { supportedLocales } from '@/lib/i18n/locales';
import type { Queryable } from '@openmaic/storage/document/pg';

export interface ResponseLanguage {
  locale: string;
  source: 'explicit' | 'conversation';
}
export function isTeachingLocale(locale: unknown): locale is string {
  return typeof locale === 'string' && supportedLocales.some((item) => item.code === locale);
}
export async function responseLanguage(
  db: Queryable,
  studyId: string,
): Promise<ResponseLanguage | null> {
  const result = await db.query<{ detail: ResponseLanguage }>(
    "SELECT detail FROM pbl_v3_evidence WHERE study_id=$1 AND kind='response-language' ORDER BY id DESC LIMIT 1",
    [studyId],
  );
  return result.rows[0]?.detail ?? null;
}
export const communicationRules = `Communication policy applies to every role, including automatic openings, assessment introductions, repair and recap. First honor a learner's explicit language request. Otherwise use the established project conversation language; before any real conversation, use communication.uiLocale. A short acknowledgement, code snippet, programming-language name (Python/Java), English option label, system stage entry, or the language of a Skill/reference is not a request to switch. When a real learner message clearly establishes a new conversation language or explicitly requests one, use set_response_language before replying so later roles inherit only that preference. An explicit preference persists until the learner explicitly changes it. Never ask another readiness/approval question to establish language. Keep authored quiz/decision wording intact; explain it in the response language without disclosing answers. Interface language and response language are separate: cite the exact productContext.visibleLabels control text, optionally followed by its translation. Never invent a translated button that is absent from the interface. When asking a learner to inspect a plan or code, read the current public file first and cite its exact relative path, relevant method/section and current 1-based line range. Use a clickable Markdown link: [src/todo.py:12–20](#pbl-file=src%2Ftodo.py&line=12&end=20), or [PLAN.md:8–15](#pbl-file=PLAN.md&line=8&end=15). Encode the path with URLSearchParams; use the reviewLink returned by file tools as the base and append observed line/end values. Never invent paths or line numbers, link private tests/rubrics, or only say “here/this code”. These links open the IDE file and select the cited range; they do not execute code, save files, approve, or advance. Recent AI changes are marked only while they match the file version; a deletion is a red boundary marker, not an added line. If lines may have moved since an earlier message, reread and issue a fresh reference.`;
