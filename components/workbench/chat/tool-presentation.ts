/**
 * What a tool call says about itself before you open it.
 *
 * Ported from the spike's `tool-presentation.ts` and grown with the toolset: one
 * row rule per tool the agent runtime can call — the course tools, the edit
 * tools, the material and web tools, the stage/series tools, `ask_user` — plus
 * the generic fallback. The retired `finish` tool is not shown.
 *
 * (Port note: the table is reconciled against THIS runtime's tool registry, not
 * the reference's. PPT-import and video/image tools are not registered upstream
 * and have no rows. The folder/rename stage tools and the
 * roster/voice-clone tools arrived on the integration base after this slice was
 * written and gained their rows with the folder-organisation and
 * roster/voice-registration tools.)
 *
 * ## The rule
 *
 * Every tool gets a **human sentence** on its collapsed row, built from the
 * tool's own STRUCTURED output — the `details` object each course tool already
 * returns — and never from parsing its prose. `details` is the tool telling
 * the program what happened (`{courseTitle, pages}`, `{order, title}`); the
 * text content is the tool telling the MODEL what happened. Summarising from
 * the first is a lookup; summarising from the second would be a parser with a
 * model on the other end of it.
 *
 * The raw wire format is never destroyed, only demoted: the card body renders
 * the pretty-printed arguments and the full result text behind the disclosure.
 *
 * ## One language
 *
 * Every tool the runtime can actually call has a **copy key** here, resolved
 * through the translator the card passes in (`lib/i18n/workbench.ts`), so a row
 * reads in the surface's language rather than in the language this table was
 * written in. The `default` branch is a fallback for a tool this file has not
 * been told about, never a shipping state: a raw wire name is the seam of this
 * table showing through the product.
 * `tests/workbench/tool-presentation.test.ts` reconciles the runner's allowlist
 * against this switch, so a newly registered tool without a label fails that
 * test rather than shipping its wire name.
 *
 * ## Two things this file must not become
 *
 *  - **A renderer.** It returns data. It imports lucide icon components
 *    because an icon IS part of the identity of a tool, but it produces no
 *    JSX, so the whole rule table below is readable as a table and testable as
 *    a function.
 *  - **A place where tool output becomes markup.** Every string here ends up
 *    in a text node. Tool results are untrusted, so they are never routed
 *    through the markdown renderer and never through `dangerouslySetInnerHTML`.
 *    (Assistant TEXT is markdown; tool output is not.)
 */
import {
  AudioLines,
  BookOpen,
  Copy,
  FileSearch,
  FolderInput,
  FolderPlus,
  FolderTree,
  Globe,
  Image as ImageIcon,
  Layers,
  Link,
  ListTree,
  MessageCircleQuestion,
  Pencil,
  Presentation,
  Scissors,
  Sparkles,
  Users,
  Volume2,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { ChatNode, PlannedPage } from '@/lib/workbench/session-store';
import { defaultWorkbenchTranslator, type WorkbenchTranslator } from '@/lib/i18n/workbench';

/**
 * Tool calls that stay off the timeline entirely:
 *
 *  - `finish` — the retired harness tool.
 * `fetch_url` stays visible: its argument is a URL the user or web_search
 * surfaced, something the reader can actually recognise.
 */
const HIDDEN_TOOLS = new Set(['finish']);

export function isHiddenWorkbenchTool(name: string | undefined): boolean {
  return !!name && HIDDEN_TOOLS.has(name);
}

/**
 * The skill-load shape lives in `lib/workbench/skill-load` so the FOLD can hold
 * the same rule: it draws the card from the durable message frames and cannot
 * import this module (icons, translator). Re-exported here because every existing
 * caller is a component next door.
 */
export { isSkillLoadTool, skillLoadId } from '@/lib/workbench/skill-load';
import { skillLoadId } from '@/lib/workbench/skill-load';

export interface ToolChip {
  label: string;
  /** `accent` for the identifying fact, `warn` for one that needs attention. */
  tone?: 'neutral' | 'accent' | 'warn';
}

export interface ToolPresentation {
  icon: LucideIcon;
  /** The verb phrase. Stable across running / done — the status dot carries state. */
  label: string;
  /** What the verb acted on: a page title, a course title. */
  subject?: string;
  /** One line of supporting detail; the card truncates it to one line. */
  detail?: string;
  chips: ToolChip[];
  /** Human-readable failure, shown on the collapsed row rather than hidden. */
  errorText?: string;
  /** Keep internal arguments/results/traces out of the disclosure UI. */
  hidePayload?: boolean;
  /** Durable text that should be shown in the expanded result section. */
  expandedResultText?: string;
  /** `read_stage_outline` — the plan, as a plan. */
  pages?: PlannedPage[];
}

// ── Small helpers ────────────────────────────────────────────────────────────

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** Flatten whitespace and clip, so a paragraph can sit on a one-line row. */
export function oneLine(value: string, max = 120): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  // Cut at a word boundary where there is one: a mid-word clip ("content …")
  // reads as a rendering bug. CJK text has no spaces and hard-cuts, which is
  // how CJK truncation is supposed to look.
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut}…`;
}

/**
 * A failure, as a sentence. The tools do not all return prose — a real run can
 * produce a `generate_scene` whose entire error result is `"gateway 524: "`,
 * accurate and unreadable on its own. The prefix supplies the subject the tool
 * did not; the raw string is still verbatim in the raw-result disclosure.
 */
function formatErrorLine(
  subject: string,
  raw: string | undefined,
  separator: string,
  max = 160,
): string {
  const message = oneLine(raw ?? '', max).replace(/[:：]\s*$/, '');
  return message ? `${subject}${separator}${message}` : subject;
}

/** The learner-facing name of a page type. `procedural-skill` is "practice". */
export function pageTypeLabel(
  type?: string,
  widgetType?: string,
  t: WorkbenchTranslator = defaultWorkbenchTranslator,
): string {
  if (type === 'quiz') return t('workbench.tool.pageType.quiz');
  if (type === 'interactive') {
    return t(
      widgetType === 'procedural-skill'
        ? 'workbench.tool.pageType.practice'
        : 'workbench.tool.pageType.interactive',
    );
  }
  return t('workbench.tool.pageType.slide');
}

function pagesOf(value: unknown): PlannedPage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  // `read_stage_outline` returns full page objects; `list_scenes` may return
  // orders. Only the object form renders as a plan.
  return value.every((p) => p && typeof p === 'object') ? (value as PlannedPage[]) : undefined;
}

/**
 * The course NAME a stage-scoped call is about — never its `stage-xxxxxxx` id.
 *
 * The curriculum tools take the id as their argument and return the name in
 * `details.title`, so a finished course tool can show a human title. A running
 * one has no details yet, and its argument is the
 * opaque id: the row then shows the verb alone, because a wire id in the subject
 * slot is noise dressed as information.
 */
function stageTitle(
  details: Record<string, unknown>,
  args: Record<string, unknown>,
): string | undefined {
  return str(details.title) ?? str(args.title);
}

const MATERIAL_TOOLS = new Set([
  'list_materials',
  'extract_material',
  'read_material',
  'use_material_media',
  'wait_for_materials',
  'search_material',
]);

function materialStatusFailed(value: unknown): boolean {
  const details = asRecord(value);
  if (details.status === 'failed') return true;
  if (!Array.isArray(details.materials)) return false;
  return details.materials.some((item) => {
    const material = asRecord(item);
    return material.status === 'failed' || asRecord(material.extraction).status === 'failed';
  });
}

/** Runtime success can still carry a terminal material-extraction failure. */
export function isWorkbenchToolFailed(node: ChatNode): boolean {
  if (node.toolState === 'failed') return true;
  return MATERIAL_TOOLS.has(node.toolName ?? '') && materialStatusFailed(node.toolDetails);
}

/**
 * The generic fallback: the argument a reader would most likely have wanted —
 * a fixed priority list of key names, then the first non-empty string. It is
 * the difference between an unknown tool rendering as its name alone and
 * rendering as `plan_course · Ancient Egypt`.
 */
const SALIENT_KEYS = [
  'title',
  'query',
  'path',
  'file',
  'command',
  'topic',
  'requirement',
  'summary',
  'skill',
  'url',
];

function salientArg(args: Record<string, unknown>): string | undefined {
  for (const key of SALIENT_KEYS) {
    const value = str(args[key]);
    if (value) return oneLine(value, 90);
  }
  for (const value of Object.values(args)) {
    const text = str(value);
    if (text) return oneLine(text, 90);
  }
  return undefined;
}

// ── The rule table ───────────────────────────────────────────────────────────

/**
 * `plan` is the session's outline. It is what lets a *running*
 * `generate_scene` say which page it is on — the tool's own `details.title`
 * does not exist until the call has finished, and the "generating page 3"
 * label with the title arriving four minutes later is exactly the "nothing is
 * happening" feeling the traces were added for.
 */
export function presentTool(
  node: ChatNode,
  plan: PlannedPage[] = [],
  t: WorkbenchTranslator = defaultWorkbenchTranslator,
): ToolPresentation {
  const name = node.toolName ?? 'tool';
  const args = node.toolArgs ?? {};
  const d = asRecord(node.toolDetails);
  const failed = isWorkbenchToolFailed(node);
  const extractionFailed = materialStatusFailed(d);
  const chips: ToolChip[] = [];
  const localizedResult = node.toolResultCopyKey ? t(node.toolResultCopyKey) : node.toolResultText;
  const errorLine = (subject: string, _raw?: string) =>
    formatErrorLine(subject, localizedResult, t('workbench.tool.errorSeparator'));

  switch (name) {
    // Material operations are intentionally one quiet, non-expandable row.
    // Their wire payload is full of internal mat_* ids and model-facing
    // guidance; the user only needs the operation and its state.
    case 'list_materials':
      return {
        icon: FileSearch,
        label: t('workbench.tool.label.listMaterials'),
        chips,
        hidePayload: true,
        ...(failed
          ? {
              errorText: t(
                extractionFailed
                  ? 'workbench.tool.error.materialExtraction'
                  : 'workbench.tool.error.listMaterials',
              ),
            }
          : {}),
      };

    case 'extract_material':
      return {
        icon: FileSearch,
        label: t('workbench.tool.label.extractMaterial'),
        chips,
        hidePayload: true,
        ...(failed ? { errorText: t('workbench.tool.error.materialExtraction') } : {}),
      };

    case 'wait_for_materials':
      return {
        icon: FileSearch,
        label: t('workbench.tool.label.waitMaterials'),
        chips,
        hidePayload: true,
        ...(failed ? { errorText: t('workbench.tool.error.materialExtraction') } : {}),
      };

    case 'read_material':
      return {
        icon: BookOpen,
        label: t('workbench.tool.label.readMaterial'),
        chips,
        hidePayload: true,
        ...(failed
          ? {
              errorText: t(
                extractionFailed
                  ? 'workbench.tool.error.materialExtraction'
                  : 'workbench.tool.error.readMaterial',
              ),
            }
          : {}),
      };

    case 'use_material_media':
      return {
        icon: ImageIcon,
        label: t('workbench.tool.label.useMaterialMedia'),
        chips,
        hidePayload: true,
        ...(failed ? { errorText: t('workbench.tool.error.readMaterial') } : {}),
      };

    case 'search_material':
      return {
        icon: FileSearch,
        label: t('workbench.tool.label.searchMaterial'),
        chips,
        hidePayload: true,
        ...(failed ? { errorText: t('workbench.tool.error.searchMaterial') } : {}),
      };

    case 'clip_audio': {
      const duration =
        num(d.durationSeconds) ??
        (num(args.endSec) !== undefined && num(args.startSec) !== undefined
          ? num(args.endSec)! - num(args.startSec)!
          : undefined);
      if (duration !== undefined) {
        chips.push({
          label: t('workbench.tool.chip.seconds', { count: duration }),
          tone: 'accent',
        });
      }
      return {
        icon: Scissors,
        label: t('workbench.tool.label.clipAudio'),
        chips,
        hidePayload: true,
        ...(failed
          ? { errorText: errorLine(t('workbench.tool.error.clipAudio'), node.toolResultText) }
          : {}),
      };
    }

    case 'register_voice':
      return {
        icon: AudioLines,
        label: t('workbench.tool.label.registerVoice'),
        subject: str(d.name) ?? str(args.name),
        chips,
        hidePayload: true,
        ...(failed
          ? { errorText: errorLine(t('workbench.tool.error.registerVoice'), node.toolResultText) }
          : {}),
      };

    case 'list_voices':
      return {
        icon: AudioLines,
        label: t('workbench.tool.label.listVoices'),
        chips,
        hidePayload: true,
        ...(failed
          ? { errorText: errorLine(t('workbench.tool.error.listVoices'), node.toolResultText) }
          : {}),
      };

    // ── The web ──────────────────────────────────────────────────────────────
    case 'web_search': {
      const sources = num(d.sources);
      if (sources !== undefined) {
        chips.push({ label: t('workbench.tool.chip.results', { count: sources }), tone: 'accent' });
      }
      return {
        icon: Globe,
        label: t('workbench.tool.label.webSearch'),
        subject: str(d.query) ?? str(args.query),
        chips,
        ...(failed
          ? { errorText: errorLine(t('workbench.tool.error.webSearch'), node.toolResultText) }
          : {}),
      };
    }

    case 'fetch_url': {
      // The subject is the URL from the ARGUMENTS, never the fetched page's own
      // `<title>`: that string is untrusted remote content, and this row is
      // product chrome. The page title stays behind the disclosure with the
      // rest of the result.
      //
      // A URL off the session's observed origins is refused as a *successful*
      // result (`details.trusted.status`), so the row says so with a chip
      // instead of an error line.
      if (str(asRecord(d.trusted).status) === 'url_not_in_session') {
        chips.push({ label: t('workbench.tool.chip.untrustedSource'), tone: 'warn' });
      }
      return {
        icon: Link,
        label: t('workbench.tool.label.fetchUrl'),
        subject: str(args.url),
        chips,
        ...(failed
          ? { errorText: errorLine(t('workbench.tool.error.fetchUrl'), node.toolResultText) }
          : {}),
      };
    }

    // Pi-native skill invocation is a `read` of SKILL.md. It is not a course
    // tool: the timeline renders it as its own skill bar, not folded into
    // "N tool calls".
    case 'read': {
      const skillId = skillLoadId(node);
      if (!skillId) {
        // A `read` of something that is not a SKILL.md — a skill's own
        // reference file, most often. Still a read, still in Chinese.
        return {
          icon: BookOpen,
          label: t('workbench.tool.label.readFile'),
          subject: salientArg(args),
          chips,
          ...(failed
            ? { errorText: errorLine(t('workbench.tool.error.readFile'), node.toolResultText) }
            : {}),
        };
      }
      return {
        icon: Sparkles,
        label: t('workbench.tool.label.loadSkill'),
        subject: skillId,
        chips,
        hidePayload: true,
        ...(failed ? { errorText: t('workbench.tool.error.loadSkill') } : {}),
      };
    }

    case 'create_skill': {
      const title = str(d.title) ?? str(args.title);
      const handle = str(d.name) ?? str(args.name);
      const description = str(d.description);
      if (!failed) {
        chips.push({ label: t('workbench.tool.chip.availableInNewSession'), tone: 'accent' });
      }
      const identity = [title, handle ? `/${handle}` : undefined].filter(Boolean).join(' ');
      return {
        icon: Sparkles,
        label: t(
          failed
            ? 'workbench.tool.label.createSkillFailed'
            : 'workbench.tool.label.createSkillSaved',
        ),
        subject: [identity, description].filter(Boolean).join(' · '),
        chips,
        // Prefer the structured saved body because raw args/results are
        // compacted out of durable session events. Args keep a live-stream
        // fallback until the completed details arrive.
        ...(!failed && node.toolState === 'done'
          ? { expandedResultText: str(d.content) ?? str(args.instructions) }
          : {}),
        ...(failed
          ? { errorText: errorLine(t('workbench.tool.error.createSkill'), node.toolResultText) }
          : {}),
      };
    }

    case 'read_skill': {
      return {
        icon: BookOpen,
        label: t('workbench.tool.label.readSkill'),
        subject: str(d.title) ?? (str(d.name) ? `/${str(d.name)}` : str(args.skillId)),
        chips,
        ...(failed
          ? { errorText: errorLine(t('workbench.tool.error.readSkill'), node.toolResultText) }
          : {}),
      };
    }

    case 'patch_skill': {
      const updated = asRecord(d.updated);
      const handle = str(updated.name) ?? str(d.name);
      if (!failed) {
        // The stored Skill changed; the copy already loaded into THIS run did
        // not. Same chip create_skill uses, for the same reason.
        chips.push({ label: t('workbench.tool.chip.availableInNewSession'), tone: 'accent' });
      }
      return {
        icon: Pencil,
        label: t('workbench.tool.label.patchSkill'),
        subject: [handle ? `/${handle}` : undefined, str(d.intent) ?? str(args.intent)]
          .filter(Boolean)
          .join(' · '),
        chips,
        ...(failed
          ? { errorText: errorLine(t('workbench.tool.error.patchSkill'), node.toolResultText) }
          : {}),
      };
    }

    case 'search_classrooms':
    case 'read_classroom':
    case 'search_chats':
    case 'read_chat': {
      const labels: Record<string, string> = {
        search_classrooms: t('workbench.tool.label.searchClassrooms'),
        read_classroom: t('workbench.tool.label.readClassroom'),
        search_chats: t('workbench.tool.label.searchChats'),
        read_chat: t('workbench.tool.label.readChat'),
      };
      const count = num(d.total) ?? (Array.isArray(d.items) ? d.items.length : undefined);
      const offset = num(d.offset) ?? num(args.offset) ?? 0;
      const limit = num(d.limit) ?? num(args.limit);
      const end = num(d.nextOffset) ?? (limit !== undefined ? offset + limit : undefined);
      if (count !== undefined) {
        chips.push({ label: t('workbench.tool.chip.records', { count }), tone: 'accent' });
      }
      if (end !== undefined && end > offset) chips.push({ label: `${offset + 1}–${end}` });
      if (d.hasMore) chips.push({ label: t('workbench.tool.chip.moreResults') });
      const recovery = str(d.recovery);
      return {
        icon: FileSearch,
        label: labels[name]!,
        subject: str(d.title) ?? str(args.query) ?? str(args.classroomId) ?? str(args.sessionId),
        chips,
        hidePayload: true,
        ...(failed
          ? {
              errorText: recovery
                ? `${errorLine(t('workbench.tool.error.historyRead'), node.toolResultText)}${t('workbench.tool.recoverySeparator')}${recovery}`
                : errorLine(t('workbench.tool.error.historyRead'), node.toolResultText),
            }
          : {}),
      };
    }

    // ── The plan ─────────────────────────────────────────────────────────────
    // ── One page ─────────────────────────────────────────────────────────────
    case 'generate_scene': {
      const order = num(d.order) ?? num(args.order);
      // The settled page brief is an explicit tool argument now (no planned
      // outline exists to look the title/type up in), so a RUNNING call can
      // show the page it is on from its own args; the finished call's details
      // remain the source of truth.
      const title = str(d.title) ?? str(args.title) ?? plan.find((p) => p.order === order)?.title;
      const planned =
        plan.find((p) => p.order === order) ??
        (typeof args.type === 'string'
          ? { order: order ?? 0, title: title ?? '', type: args.type }
          : undefined);
      if (planned) chips.push({ label: pageTypeLabel(planned.type, planned.widgetType, t) });
      if (str(args.instruction)) {
        chips.push({ label: t('workbench.tool.chip.reviseAsDirected'), tone: 'accent' });
      }
      return {
        icon: Layers,
        label: order
          ? t('workbench.tool.label.generateSceneOrder', { order })
          : t('workbench.tool.label.generateScene'),
        subject: title,
        detail: str(args.instruction),
        chips,
        ...(failed
          ? {
              errorText: errorLine(
                t('workbench.tool.error.generateScene', { order: order ?? '?' }),
                node.toolResultText,
              ),
            }
          : {}),
      };
    }

    case 'duplicate_scene': {
      const order = num(d.order) ?? num(args.targetOrder);
      if (order !== undefined) {
        chips.push({ label: t('workbench.tool.chip.pageOrder', { order }) });
      }
      if (d.replay) chips.push({ label: t('workbench.tool.chip.duplicateExists') });
      return {
        icon: Copy,
        label: t('workbench.tool.label.duplicateScene'),
        subject: str(d.title) ?? str(args.title),
        chips,
        ...(failed
          ? {
              errorText: errorLine(t('workbench.tool.error.duplicateScene'), node.toolResultText),
            }
          : {}),
      };
    }

    case 'generate_actions': {
      const order = num(d.order) ?? num(args.order);
      const actions = Array.isArray(d.actions) ? d.actions.length : undefined;
      const audio = asRecord(d.audio);
      const synthesized = num(audio.synthesized);
      const missing = Array.isArray(audio.missing) ? audio.missing.length : 0;
      if (actions !== undefined) {
        chips.push({ label: t('workbench.tool.chip.actions', { count: actions }), tone: 'accent' });
      }
      if (synthesized !== undefined) {
        chips.push({ label: t('workbench.tool.chip.voicedLines', { count: synthesized }) });
      }
      if (missing > 0) {
        chips.push({
          label: t('workbench.tool.chip.unvoicedLines', { count: missing }),
          tone: 'warn',
        });
      }
      return {
        icon: AudioLines,
        label:
          order !== undefined
            ? t('workbench.tool.label.generateActionsOrder', { order })
            : t('workbench.tool.label.generateActions'),
        subject: plan.find((p) => p.order === order)?.title,
        chips,
        ...(failed
          ? {
              errorText: errorLine(t('workbench.tool.error.generateActions'), node.toolResultText),
            }
          : {}),
      };
    }

    case 'generate_tts': {
      const order = num(d.order) ?? num(args.order);
      const results = Array.isArray(d.results)
        ? (d.results as unknown[]).map((r) => str(asRecord(r).status))
        : undefined;
      if (results) {
        const generated = results.filter((s) => s === 'generated').length;
        const skipped = results.filter((s) => s === 'skipped').length;
        const failedLines = results.filter((s) => s === 'failed').length;
        if (generated > 0) {
          chips.push({
            label: t('workbench.tool.chip.synthesizedLines', { count: generated }),
            tone: 'accent',
          });
        }
        if (skipped > 0) {
          chips.push({ label: t('workbench.tool.chip.existingLines', { count: skipped }) });
        }
        if (failedLines > 0) {
          chips.push({
            label: t('workbench.tool.chip.failedLines', { count: failedLines }),
            tone: 'warn',
          });
        }
      }
      return {
        icon: Volume2,
        label:
          order !== undefined
            ? t('workbench.tool.label.generateTtsOrder', { order })
            : t('workbench.tool.label.generateTts'),
        subject: plan.find((p) => p.order === order)?.title,
        chips,
        ...(failed
          ? {
              errorText:
                d.provider === null
                  ? t('workbench.tool.error.noTtsProvider')
                  : errorLine(t('workbench.tool.error.generateTts'), node.toolResultText),
            }
          : {}),
      };
    }

    case 'render_scene_preview':
      // `args.sceneId` is a persisted scene id, and the plan is keyed by order,
      // so there is no title to resolve here — the verb stands alone.
      return {
        icon: ImageIcon,
        label: t('workbench.tool.label.previewScene'),
        chips,
        ...(failed
          ? { errorText: errorLine(t('workbench.tool.error.previewScene'), node.toolResultText) }
          : {}),
      };

    // ── Stage-document tools ──────────────────────────────────────────────────
    // The subject is what the agent actually
    // aimed at: the document path it read, the intent it wrote for, the query it
    // searched — never the wire stageId.
    case 'read_stage': {
      const path = str(d.path) ?? str(args.path);
      return {
        icon: BookOpen,
        label: t('workbench.tool.label.readCourse'),
        // path "" is the whole stage — the verb alone is the honest row.
        subject: path && path !== '' ? path : undefined,
        chips,
        ...(failed
          ? { errorText: errorLine(t('workbench.tool.error.readCourse'), node.toolResultText) }
          : {}),
      };
    }

    case 'patch_stage': {
      const updated = asRecord(d.updated);
      const order = num(updated.order);
      if (order !== undefined) {
        chips.push({ label: t('workbench.tool.chip.pageOrder', { order }) });
      }
      return {
        icon: Pencil,
        label: t('workbench.tool.label.patchCourse'),
        subject: str(d.intent) ?? str(args.intent),
        chips,
        ...(failed
          ? { errorText: errorLine(t('workbench.tool.error.patchCourse'), node.toolResultText) }
          : {}),
      };
    }

    case 'grep_stage': {
      const hits = Array.isArray(d.hits) ? d.hits.length : undefined;
      if (hits !== undefined) {
        chips.push({
          label: t('workbench.tool.chip.grepHits', { count: hits }),
          tone: 'accent',
        });
      }
      if (d.truncated) chips.push({ label: t('workbench.tool.chip.truncated'), tone: 'warn' });
      return {
        icon: FileSearch,
        label: t('workbench.tool.label.grepCourse'),
        subject: str(d.query) ?? str(args.query),
        chips,
        ...(failed
          ? { errorText: errorLine(t('workbench.tool.error.grepCourse'), node.toolResultText) }
          : {}),
      };
    }

    case 'edit_deck': {
      return {
        icon: Pencil,
        label: t('workbench.tool.label.editDeck'),
        subject: str(args.op) ?? str(d.op),
        chips,
        ...(failed
          ? { errorText: errorLine(t('workbench.tool.error.editPage'), node.toolResultText) }
          : {}),
      };
    }

    // ── Reading its own work ─────────────────────────────────────────────────
    case 'list_scenes': {
      const persisted = Array.isArray(d.persisted) ? d.persisted.length : undefined;
      const missing = Array.isArray(d.missing) ? (d.missing as unknown[]) : undefined;
      if (persisted !== undefined) {
        chips.push({
          label: t('workbench.tool.chip.persistedPages', { count: persisted }),
          tone: 'accent',
        });
      }
      if (missing && missing.length > 0) {
        chips.push({
          label: t('workbench.tool.chip.missingPages', { count: missing.length }),
          tone: 'warn',
        });
      }
      return {
        icon: FileSearch,
        label: t('workbench.tool.label.listScenes'),
        chips,
        ...(failed
          ? { errorText: errorLine(t('workbench.tool.error.listScenes'), node.toolResultText) }
          : {}),
      };
    }

    // ── Asking the user ──────────────────────────────────────────────────────
    // The payload stays hidden: the question card right below this row already
    // renders the question and its options, and the answer form is the user's
    // copy of it. Repeating the wire envelope in a disclosure is the same
    // sentence a third time.
    case 'ask_user': {
      const question = str(d.question) ?? str(args.question);
      const options = Array.isArray(d.options)
        ? d.options.length
        : Array.isArray(args.options)
          ? args.options.length
          : 0;
      if (options > 0) {
        chips.push({ label: t('workbench.tool.chip.options', { count: options }) });
      }
      return {
        icon: MessageCircleQuestion,
        label: t('workbench.tool.label.askUser'),
        subject: question ? oneLine(question, 90) : undefined,
        chips,
        hidePayload: true,
        ...(failed
          ? { errorText: errorLine(t('workbench.tool.error.askUser'), node.toolResultText) }
          : {}),
      };
    }

    // ── The classroom's cast ─────────────────────────────────────────────────
    case 'generate_roster':
    case 'set_roster': {
      const roster = Array.isArray(d.roster) ? (d.roster as unknown[]) : undefined;
      if (roster) {
        chips.push({
          label: t('workbench.tool.chip.roles', { count: roster.length }),
          tone: 'accent',
        });
      }
      if (d.voicesAvailable === false) {
        chips.push({ label: t('workbench.tool.chip.noVoices'), tone: 'warn' });
      }
      const names = roster
        ?.map((agent) => str(asRecord(agent).name))
        .filter((n): n is string => !!n);
      return {
        icon: Users,
        // `generate_roster` designs the cast; `set_roster` writes down the one
        // the user already named. Same object, different authorship.
        label: t(
          name === 'set_roster'
            ? 'workbench.tool.label.setRoster'
            : 'workbench.tool.label.generateRoster',
        ),
        subject:
          names && names.length > 0
            ? oneLine(names.join(t('workbench.tool.listSeparator')), 90)
            : undefined,
        chips,
        ...(failed
          ? { errorText: errorLine(t('workbench.tool.error.roster'), node.toolResultText) }
          : {}),
      };
    }

    // ── The series layer: folders and other stages ────────────────────────────
    case 'create_folder':
      return {
        icon: FolderPlus,
        label: t('workbench.tool.label.createFolder'),
        subject: str(d.name) ?? str(args.name),
        chips,
        ...(failed
          ? { errorText: errorLine(t('workbench.tool.error.createFolder'), node.toolResultText) }
          : {}),
      };

    case 'move_to_folder':
      // Both arguments are ids and the result names the course only in prose,
      // which this file does not parse — so this row is the verb alone (see
      // `stageTitle`).
      return {
        icon: FolderInput,
        label: t('workbench.tool.label.moveToFolder'),
        chips,
        ...(failed
          ? { errorText: errorLine(t('workbench.tool.error.moveToFolder'), node.toolResultText) }
          : {}),
      };

    case 'list_folder_stages': {
      const count = num(d.count) ?? (Array.isArray(d.courses) ? d.courses.length : undefined);
      if (count !== undefined) {
        chips.push({ label: t('workbench.tool.chip.courses', { count }), tone: 'accent' });
      }
      return {
        icon: FolderTree,
        label: t('workbench.tool.label.listFolderCourses'),
        // No argument means the whole library; with a folder id the scope is
        // one folder, whose name this call never learns.
        subject: t(
          str(args.folderId)
            ? 'workbench.tool.chip.folderCourses'
            : 'workbench.tool.chip.allCourses',
        ),
        chips,
        ...(failed
          ? {
              errorText: errorLine(
                t('workbench.tool.error.listFolderCourses'),
                node.toolResultText,
              ),
            }
          : {}),
      };
    }

    case 'create_stage':
      if (d.reused) chips.push({ label: t('workbench.tool.chip.reusedCourse') });
      if (str(d.folderId)) chips.push({ label: t('workbench.tool.chip.movedToFolder') });
      return {
        icon: Presentation,
        label: t('workbench.tool.label.createStage'),
        subject: stageTitle(d, args),
        chips,
        ...(failed
          ? { errorText: errorLine(t('workbench.tool.error.createStage'), node.toolResultText) }
          : {}),
      };

    case 'rename_stage':
      // The subject is the NEW name (the result names it in `details.title`;
      // while running, the argument carries it as `name`) — the id it acted on
      // is the opaque stage-xxx the reader never chose.
      return {
        icon: Pencil,
        label: t('workbench.tool.label.renameStage'),
        subject: str(d.title) ?? str(args.name),
        chips,
        ...(failed
          ? { errorText: errorLine(t('workbench.tool.error.renameStage'), node.toolResultText) }
          : {}),
      };

    case 'read_stage_outline': {
      const pages = pagesOf(d.pages);
      const count = num(d.pageCount) ?? pages?.length;
      if (count !== undefined) {
        chips.push({ label: t('workbench.tool.chip.pages', { count }), tone: 'accent' });
      }
      return {
        icon: ListTree,
        label: t('workbench.tool.label.readStageOutline'),
        subject: stageTitle(d, args),
        ...(pages && pages.length > 0
          ? { detail: pages.map((p) => `${p.order}. ${p.title}`).join(' · ') }
          : {}),
        chips,
        ...(failed
          ? {
              errorText: errorLine(t('workbench.tool.error.readStageOutline'), node.toolResultText),
            }
          : {}),
      };
    }

    // ── Anything this file has not been told about ───────────────────────────
    // The wire name, in English, is the honest rendering of a tool nobody wrote
    // a row for — and it is a bug, not a design: every tool the runner
    // registers is reconciled against this switch in the tests. Reaching here
    // means a tool shipped before its label did.
    default:
      return {
        icon: Wrench,
        label: name,
        subject: salientArg(args),
        chips,
        ...(failed
          ? { errorText: errorLine(t('workbench.tool.error.generic'), node.toolResultText) }
          : {}),
      };
  }
}

/** Safe stringify of an unknown tool payload for the expanded body. */
export function formatToolPayload(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
