'use client';

/**
 * Shared composer extras for the Pro workbench surfaces: material attachment
 * (durable upload through `POST /api/materials`) and the `/` skill menu. Used by
 * the homepage/workspace launch face and the ongoing conversation composer.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { AtSign, Loader2, Paperclip, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils/cn';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  uploadWorkbenchMaterial,
  useWorkbenchStore,
  WorkbenchMaterialUploadError,
  type WorkbenchMaterial,
} from '@/lib/workbench/session-store';
import { skillTitle, useAgentSkills, type AgentSkillInfo } from '@/lib/workbench/agent-skills';
import {
  createMaterialUploadIdentityGate,
  MaterialSlotLedger,
  MAX_COMPOSER_MATERIALS,
  retryMaterialUpload,
  scheduleMaterialUploadBatch,
} from '@/lib/workbench/material-upload-scheduling';
import { WORKBENCH_MATERIAL_ACCEPT } from '@/lib/workbench/material-upload-policy';
import { slashQuery } from '@/lib/workbench/composer-skills';
import {
  fetchMaterialMentionListing,
  materialMentionCandidates,
  type MaterialMentionCandidate,
} from '@/lib/workbench/material-mention';
import { ComposerPendingPill, ComposerPill, ComposerPillRow } from './composer-pill';

// ── Skills (the `/` and composer `+` menus) ──────────────────────────────────
//
// The registry itself (the fetch, its cache, `useAgentSkills`) lives in
// `lib/workbench/agent-skills` so the chat timeline can name a loaded skill
// without importing the composer's upload machinery. The `/` grammar
// (`slashQuery`, and writing a handle into the draft) lives in
// `lib/workbench/composer-skills`. Both re-exported here because every composer
// surface already imports skills from this module.

export { useAgentSkills, slashQuery, type AgentSkillInfo };

export function SkillSlashMenu({
  filter,
  onPick,
  onDismiss,
  title,
}: {
  filter: string;
  onPick: (skill: AgentSkillInfo) => void;
  /**
   * The menu's one exit — the SAME contract the `@` course menu has with
   * `closeMention`: Escape (from the textarea OR from inside the menu) and a
   * press outside both go through here, and the SURFACE records the dismissal
   * against its draft, which is what unmounts this menu. No local hidden
   * state: a menu that closes itself while its trigger text is still live
   * leaves the surface believing it is open, and the skill button's next
   * click dying on a zombie.
   */
  onDismiss: () => void;
  title: string;
}) {
  const { t } = useI18n();
  const { skills, loading, error, reload } = useAgentSkills();
  const titleId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const matches = [...skills]
    .sort((a, b) => Number(b.source === 'user') - Number(a.source === 'user'))
    .filter(
      (s) =>
        !filter ||
        s.name.toLowerCase().includes(filter.toLowerCase()) ||
        // The row leads with the display name, so typing THAT has to find the row
        // — in whichever language it is currently reading in.
        (skillTitle(s, t) ?? '').toLowerCase().includes(filter.toLowerCase()) ||
        (s.title ?? '').toLowerCase().includes(filter.toLowerCase()),
    );

  useEffect(() => {
    const option = optionRefs.current[highlightedIndex];
    option?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex]);

  useEffect(() => {
    // A press outside the menu puts it away — same rule, same exceptions as
    // `CourseMentionMenu`: the textarea is exempt (moving the caret while
    // typing a query is not "somewhere else"), and elements marked
    // `data-mention-keep-open` exempt themselves.
    const onPointerDown = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (menuRef.current?.contains(target)) return;
      if (target.closest('[data-mention-keep-open]')) return;
      onDismiss();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [onDismiss]);

  useEffect(() => {
    // Escape is armed even with NOTHING to pick: the menu can open onto a
    // failed or empty list (the skill button seeds `/` without asking the
    // registry first), and a menu that cannot be closed is worse than one that
    // closes without choosing. It also closes from INSIDE the menu — the
    // error branch's retry button can hold focus, and the keyboard must still
    // work afterwards. Navigation and picking stay matches-gated.
    const onKeyDown = (event: KeyboardEvent) => {
      const textarea = menuRef.current?.parentElement?.querySelector('textarea');
      const onTextarea = event.target === textarea;
      if (event.isComposing) return;

      if (event.key === 'Escape') {
        const inMenu =
          event.target instanceof Node && menuRef.current?.contains(event.target) === true;
        if (!onTextarea && !inMenu) return;
        event.preventDefault();
        event.stopPropagation();
        onDismiss();
        return;
      }

      if (!onTextarea || matches.length === 0) return;

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        setHighlightedIndex((current) => (current + direction + matches.length) % matches.length);
        return;
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        onPick(matches[highlightedIndex] ?? matches[0]);
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [highlightedIndex, matches, onDismiss, onPick]);

  const groups = [
    { source: 'user' as const, label: t('proMode.userSkillsGroup') },
    { source: 'builtin' as const, label: t('proMode.builtinSkillsGroup') },
  ];
  return (
    <div
      ref={menuRef}
      data-testid="workbench-skill-menu"
      data-esc-owner=""
      role="listbox"
      aria-labelledby={titleId}
      className="pro-skill-slash-popover absolute bottom-full left-0 z-30 mb-1.5 w-full max-w-[340px] overflow-hidden rounded-xl border border-border bg-popover shadow-lg"
    >
      <p id={titleId} className="px-3 pb-1 pt-2 text-[10.5px] font-medium text-muted-foreground">
        {title}
      </p>
      <ul className="max-h-56 overflow-y-auto pb-1">
        {loading ? (
          <li className="flex items-center gap-2 px-3 py-3 text-[11px] text-muted-foreground">
            <Loader2 className="size-3 animate-spin motion-reduce:animate-none" />
            {t('proMode.skillsLoading')}
          </li>
        ) : error ? (
          <li className="px-3 py-3 text-[11px] text-muted-foreground">
            <span>{t('proMode.skillsLoadFailed')}</span>{' '}
            <button
              type="button"
              className="text-[var(--wb-accent)] hover:underline"
              onClick={() => void reload().catch(() => {})}
            >
              {t('proMode.retrySkills')}
            </button>
          </li>
        ) : matches.length === 0 ? (
          <li className="px-3 py-3 text-[11px] text-muted-foreground">
            {filter
              ? t('proMode.noSkillMatch', { query: `/${filter}` })
              : t('proMode.noSkillsAvailable')}
          </li>
        ) : (
          groups.map((group) => {
            const items = matches.filter((skill) => skill.source === group.source);
            if (items.length === 0) return null;
            return (
              <li key={group.source}>
                <p className="px-3 pb-1 pt-2 text-[10px] font-medium text-muted-foreground">
                  {group.label}
                </p>
                <ul>
                  {items.map((skill) => {
                    const index = matches.indexOf(skill);
                    return (
                      <li key={skill.id}>
                        <button
                          ref={(node) => {
                            optionRefs.current[index] = node;
                          }}
                          type="button"
                          role="option"
                          aria-selected={index === highlightedIndex}
                          data-highlighted={index === highlightedIndex ? 'true' : undefined}
                          data-testid={`workbench-skill-option-${skill.id}`}
                          onClick={() => onPick(skill)}
                          onMouseEnter={() => setHighlightedIndex(index)}
                          className={cn(
                            'flex w-full flex-col gap-0.5 px-3 py-2 text-left transition-colors hover:bg-muted',
                            index === highlightedIndex && 'bg-muted',
                          )}
                        >
                          <span className="flex min-w-0 max-w-full items-baseline gap-1.5">
                            {/* Display name + English id: the name is what the reader
                    recognises, the id is what they type and what the session
                    records. The id is never dropped — it is the skill's actual
                    handle. */}
                            {skillTitle(skill, t) ? (
                              <span className="min-w-0 truncate text-[12.5px] font-medium text-foreground">
                                {skillTitle(skill, t)}
                              </span>
                            ) : null}
                            <span
                              className={cn(
                                'shrink-0 text-[11px] text-muted-foreground',
                                !skillTitle(skill, t) &&
                                  'text-[12.5px] font-medium text-foreground',
                              )}
                            >
                              /{skill.name}
                            </span>
                          </span>
                          <span className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                            {skill.description}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}

// ── Materials ────────────────────────────────────────────────────────────────

/**
 * A picked file that is not yet settled: a stable per-file id plus the
 * display name. The id is what chips key on and settlement matches by.
 */
export interface MaterialUploadEntry {
  id: string;
  name: string;
}

/** What `addExisting` did: staged it, found it staged, or could not (cap, gate). */
export type AddExistingOutcome = 'staged' | 'already' | 'full' | 'disabled';

export interface ComposerMaterials {
  /** Runtime rollout gate shared by picker, paste, and drop entry points. */
  enabled: boolean;
  /** The gate has answered, either way (`enabled` alone cannot tell "not yet" from "no"). */
  enabledKnown: boolean;
  materials: WorkbenchMaterial[];
  /**
   * Files picked but not yet settled, in pick order. Every entry is rendered
   * as a spinner chip immediately; uploads settle each entry by id, so
   * concurrent selections never hide each other behind a single slot.
   */
  uploading: MaterialUploadEntry[];
  /** Entries whose upload failed (shown as removable error chips). */
  failed: MaterialUploadEntry[];
  addFiles: (files: FileList | File[]) => void;
  /**
   * Stage a material the knowledge base already holds (the `@` picker): one
   * more pill, attached only when the message is sent. One already staged is
   * left as it is; the per-message cap applies as it does to uploads.
   * Answers what happened, for a caller that must know (the knowledge base
   * page's hand-over); `full` has already told the user.
   */
  addExisting: (material: WorkbenchMaterial) => AddExistingOutcome;
  remove: (materialId: string) => void;
  removeFailed: (id: string) => void;
  /** Remove only the staged objects accepted by this send. Later picks survive. */
  removeSent: (sent: readonly WorkbenchMaterial[]) => void;
  clear: () => void;
  /**
   * A new conversation in this composer: nothing staged, uploading or failed
   * is kept, and an upload still in flight is no longer this draft's -- it
   * may finish into the library, but its pill, failure and slot stay with
   * the draft it was picked for. `clear` keeps such uploads.
   */
  startOver: () => void;
  /** True while any upload is in flight — submits should wait for it. */
  busy: boolean;
}

let materialsEnabledCache: boolean | null = null;
let materialsProbe: Promise<boolean> | null = null;

/**
 * The server's answer, remembered for the life of the tab: whether the
 * material upload path can actually serve a request.
 *
 * The branch substitution: the reference's probe reads `materialsEnabled`
 * (its runtime answers `enabled && isAgentMaterialsEnabled()`). This port has
 * no separate materials flag — the materials routes gate on the runtime
 * itself (materials are consumed by agent sessions) — so the probe reads the runtime's `enabled` field,
 * which IS the upload action's precondition (`POST /api/materials` 404s when
 * it is false).
 */
async function probeMaterialsEnabled(): Promise<boolean> {
  if (materialsEnabledCache !== null) return materialsEnabledCache;
  if (!materialsProbe) {
    materialsProbe = fetch('/api/agent/runtime')
      .then(async (response) => (response.ok ? ((await response.json()) as unknown) : null))
      .then((body) => {
        const enabled =
          !!body && typeof body === 'object' && (body as { enabled?: unknown }).enabled === true;
        materialsEnabledCache = enabled;
        return enabled;
      })
      .catch(() => false)
      .finally(() => {
        materialsProbe = null;
      });
  }
  return materialsProbe;
}

/** The rollout gate as this surface knows it: still asking, or the answer. */
type MaterialUploadsGate = 'pending' | 'on' | 'off';

function useMaterialUploadsGate(): MaterialUploadsGate {
  const [gate, setGate] = useState<MaterialUploadsGate>(() =>
    materialsEnabledCache === null ? 'pending' : materialsEnabledCache ? 'on' : 'off',
  );
  useEffect(() => {
    let cancelled = false;
    void probeMaterialsEnabled().then((value) => {
      if (!cancelled) setGate(value ? 'on' : 'off');
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return gate;
}

/** Runtime-delivered rollout gate; false until the server probe says true. */
export function useMaterialUploadsEnabled(): boolean {
  return useMaterialUploadsGate() === 'on';
}

export function useComposerMaterials(
  initialMaterials: readonly WorkbenchMaterial[] = [],
): ComposerMaterials {
  const { t, locale } = useI18n();
  const gate = useMaterialUploadsGate();
  const enabled = gate === 'on';
  const initial = useRef<WorkbenchMaterial[] | null>(null);
  if (initial.current === null) {
    initial.current = initialMaterials.slice(0, MAX_COMPOSER_MATERIALS);
  }
  const [materials, setMaterials] = useState<WorkbenchMaterial[]>(() => [...initial.current!]);
  const [uploading, setUploading] = useState<MaterialUploadEntry[]>([]);
  const [failed, setFailed] = useState<MaterialUploadEntry[]>([]);
  // Include picks queued before the next render, retaining the current object
  // so a completed send cannot remove a later pick with the same id.
  const stagedObjects = useRef(new Set(initial.current));
  const seq = useRef(0);
  const slotLedger = useRef(new MaterialSlotLedger(initial.current.length));
  const identityGate = useRef(createMaterialUploadIdentityGate());
  /** Bumped by `startOver`; an upload belongs to the draft it was picked in. */
  const draft = useRef(0);

  const addFiles = (files: FileList | File[]) => {
    if (!enabled) return;
    const selected = Array.from(files);
    if (!slotLedger.current.canAccept(selected.length)) {
      toast.error(t('workbench.material.maxSelected', { count: MAX_COMPOSER_MATERIALS }));
      return;
    }
    const ledger = slotLedger.current;
    const pickedIn = draft.current;
    ledger.reserve(selected.length);

    // Register every picked file as a pending chip BEFORE any upload runs, so
    // a slow first upload never hides later selections. Uploads are settled
    // per entry by id, each flipping independently to done or failed.
    const jobs = selected.map((file) => ({
      file,
      entry: {
        id: `${Date.now()}-${seq.current++}-${file.name}`,
        name: file.name,
      },
    }));
    setUploading((items) => [...items, ...jobs.map((job) => job.entry)]);

    const upload = async ({
      file,
      entry,
    }: {
      file: File;
      entry: MaterialUploadEntry;
    }): Promise<boolean> => {
      let succeeded = false;
      try {
        const staged = await retryMaterialUpload(() => uploadWorkbenchMaterial(file));
        succeeded = true;
        if (draft.current === pickedIn) {
          stagedObjects.current.add(staged);
          setMaterials((current) => [...current, staged]);
        }
        return true;
      } catch (err) {
        if (draft.current !== pickedIn) return false;
        setFailed((items) => [...items, entry]);
        toast.error(
          err instanceof WorkbenchMaterialUploadError
            ? err.userMessage(t, locale)
            : err instanceof Error
              ? err.message
              : t('workbench.material.uploadFailed', { name: file.name }),
        );
        return false;
      } finally {
        ledger.settle(succeeded);
        setUploading((items) => items.filter((item) => item.id !== entry.id));
      }
    };

    void scheduleMaterialUploadBatch(identityGate.current, jobs, upload);
  };

  const addExisting = (material: WorkbenchMaterial): AddExistingOutcome => {
    if (!enabled) return 'disabled';
    if ([...stagedObjects.current].some((item) => item.materialId === material.materialId)) {
      return 'already';
    }
    if (!slotLedger.current.canAccept(1)) {
      toast.error(t('workbench.material.maxSelected', { count: MAX_COMPOSER_MATERIALS }));
      return 'full';
    }
    slotLedger.current.reserve(1);
    stagedObjects.current.add(material);
    slotLedger.current.settle(true);
    setMaterials((current) =>
      current.some((item) => item.materialId === material.materialId)
        ? current
        : [...current, material],
    );
    return 'staged';
  };

  return {
    enabled,
    enabledKnown: gate !== 'pending',
    materials,
    uploading,
    failed,
    addFiles,
    addExisting,
    remove: (materialId) => {
      for (const item of stagedObjects.current) {
        if (item.materialId === materialId) {
          stagedObjects.current.delete(item);
          slotLedger.current.removeCompleted();
        }
      }
      setMaterials((items) => items.filter((item) => item.materialId !== materialId));
    },
    removeFailed: (id) => setFailed((items) => items.filter((item) => item.id !== id)),
    removeSent: (sent) => {
      const snapshot = new Set(sent);
      for (const item of snapshot) {
        if (stagedObjects.current.delete(item)) {
          slotLedger.current.removeCompleted();
        }
      }
      // The updater is pure: StrictMode replay cannot release a slot twice.
      setMaterials((items) => items.filter((item) => !snapshot.has(item)));
    },
    clear: () => {
      // Uploads are not cancelled by clear. Keep their reservations so a late
      // success remains counted when its pill appears after this reset.
      stagedObjects.current.clear();
      slotLedger.current.clearCompleted();
      setMaterials([]);
      setFailed([]);
    },
    startOver: () => {
      draft.current += 1;
      stagedObjects.current.clear();
      // A fresh ledger: uploads in flight settle into the old one.
      slotLedger.current = new MaterialSlotLedger(0);
      setMaterials([]);
      setUploading([]);
      setFailed([]);
    },
    busy: uploading.length > 0,
  };
}

/** Which composer a knowledge base hand-over is for, decided when it was asked. */
export type MaterialSeedTarget =
  | { readonly kind: 'home' }
  /** A conversation's composer, by its owner key (`draft:<courseId>` for a new one). */
  | { readonly kind: 'chat'; readonly ownerKey: string };

/**
 * "Chat with this material" from the knowledge base page: one material to
 * stage in one composer, once. `key` tells one hand-over from the next.
 */
export interface MaterialSeed {
  readonly key: number;
  readonly material: WorkbenchMaterial;
  readonly target: MaterialSeedTarget;
}

/**
 * Stage a hand-over in this composer if it is the one the hand-over names,
 * and say whether the composer must wait for it.
 *
 * While the materials gate has not answered, the hand-over waits -- and so
 * must this composer's send (the answer is `true`): a message sent then would
 * leave without the material the teacher chose. Once the gate answers yes it
 * is staged -- only staged, nothing is uploaded or attached before the
 * message is sent (RFC #1716 §4); answered no, nothing can be staged here and
 * the hand-over is over. `onConsumed` hands the key back once, when the
 * outcome is known: staged, already staged, refused by the per-message cap
 * (which `addExisting` has already told the user; not kept to reappear
 * later), or materials not offered.
 *
 * Call it AFTER any effect that resets the composer. A reset that runs again
 * for the same hand-over -- React replaying effects in development -- is
 * answered by staging it again (`addExisting` keeps one pill per material);
 * a refused one is not tried twice.
 */
export function useMaterialSeed(input: {
  readonly seed: MaterialSeed | null | undefined;
  /** This composer is the seed's target. */
  readonly targeted: boolean;
  readonly materials: Pick<ComposerMaterials, 'enabled' | 'enabledKnown' | 'addExisting'>;
  readonly onConsumed?: (key: number) => void;
}): boolean {
  const { seed, targeted, materials, onConsumed } = input;
  /** The hand-over this composer answered, and how. */
  const handled = useRef<{ readonly key: number; readonly outcome: AddExistingOutcome } | null>(
    null,
  );
  useEffect(() => {
    if (!seed || !targeted || !materials.enabledKnown) return;
    const earlier = handled.current?.key === seed.key ? handled.current.outcome : null;
    if (earlier === 'full' || earlier === 'disabled') return;
    const outcome = materials.enabled ? materials.addExisting(seed.material) : 'disabled';
    if (earlier !== null) return;
    handled.current = { key: seed.key, outcome };
    onConsumed?.(seed.key);
    // `materials` is a fresh object each render; the gate is what can change
    // the outcome, and `handled` keeps the answer to one per key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed, targeted, materials.enabled, materials.enabledKnown]);
  return Boolean(seed && targeted && !materials.enabledKnown);
}

export function AttachButton({
  onFiles,
  disabled,
  label,
  testId = 'workbench-attach',
}: {
  onFiles: (files: FileList | File[]) => void;
  disabled?: boolean;
  label: string;
  testId?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const materialsEnabled = useMaterialUploadsEnabled();
  if (!materialsEnabled) return null;
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={WORKBENCH_MATERIAL_ACCEPT}
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) onFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-testid={testId}
            disabled={disabled}
            aria-label={label}
            onClick={() => inputRef.current?.click()}
            className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            <Paperclip className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {label}
        </TooltipContent>
      </Tooltip>
    </>
  );
}

/**
 * The composer's classroom-mention entry, between attach and skill. Clicking
 * opens the SAME course picker the `@` keystroke opens — the surface's
 * `openMention` focuses the textarea first, because the picker's ↑/↓/Enter
 * contract lives there. Purely presentational, like its two neighbours.
 */
export function AtSignButton({
  onClick,
  disabled,
  label,
  testId = 'workbench-mention-button',
}: {
  onClick: () => void;
  disabled?: boolean;
  label: string;
  testId?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-testid={testId}
          disabled={disabled}
          aria-label={label}
          onClick={onClick}
          className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          <AtSign className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The composer's skill entry — the ZCode-shaped half of the old `+`: clicking
 * opens the slash menu over the input by seeding a `/` token at the caret (the
 * surface's `openSkillMenu`), and picking writes the `/handle` into the draft
 * as text. Purely presentational; each surface wires its own draft/caret
 * mechanics into `onClick`.
 */
export function SkillButton({
  onClick,
  disabled,
  label,
  testId = 'workbench-skill-button',
}: {
  onClick: () => void;
  disabled?: boolean;
  label: string;
  testId?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-testid={testId}
          disabled={disabled}
          aria-label={label}
          onClick={onClick}
          className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          <Sparkles className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

export function MaterialChips({
  materials,
  uploading,
  failed = [],
  onRemove,
  onRemoveFailed,
  className,
  inline = false,
}: {
  materials: WorkbenchMaterial[];
  uploading: MaterialUploadEntry[];
  failed?: MaterialUploadEntry[];
  onRemove: (materialId: string) => void;
  onRemoveFailed?: (id: string) => void;
  className?: string;
  /** Share the caller's pill row instead of opening one (see `ComposerPillRow`). */
  inline?: boolean;
}) {
  const { t } = useI18n();
  if (materials.length === 0 && uploading.length === 0 && failed.length === 0) return null;
  return (
    <ComposerPillRow
      className={inline ? undefined : className}
      contents={inline}
      testId="workbench-materials"
    >
      {materials.map((m) => (
        <ComposerPill
          key={m.materialId}
          icon={<Paperclip size={10} />}
          label={m.name}
          title={m.name}
          onRemove={() => onRemove(m.materialId)}
          removeLabel={t('workbench.material.remove', { name: m.name })}
        />
      ))}
      {uploading.map((entry) => (
        <ComposerPendingPill key={entry.id} label={entry.name} />
      ))}
      {failed.map((entry) => (
        <ComposerPill
          key={entry.id}
          tone="danger"
          icon={<Paperclip size={10} />}
          label={entry.name}
          title={entry.name}
          onRemove={onRemoveFailed ? () => onRemoveFailed(entry.id) : undefined}
          removeLabel={t('workbench.material.removeFailed')}
        />
      ))}
    </ComposerPillRow>
  );
}

/**
 * The knowledge base's sources for the `@` menu while it is open, matching
 * the typed query (debounced), marked for this conversation and for what is
 * already staged. `undefined` while materials are not offered at all, so the
 * menu stays the classroom picker. A material change of this run
 * (`materialLibraryRevision`) refetches.
 */
export function useMaterialMentions(input: {
  open: boolean;
  enabled: boolean;
  query: string;
  sessionId: string | null;
  staged: readonly WorkbenchMaterial[];
}): MaterialMentionCandidate[] | undefined {
  const { open, enabled, query, sessionId, staged } = input;
  const revision = useWorkbenchStore((state) => state.materialLibraryRevision);
  const [listing, setListing] = useState<{
    query: string;
    sessionId: string | null;
    materials: Awaited<ReturnType<typeof fetchMaterialMentionListing>>;
  }>();
  useEffect(() => {
    if (!open || !enabled) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void fetchMaterialMentionListing({ query, sessionId, signal: controller.signal }).then(
        (materials) => {
          if (!controller.signal.aborted) setListing({ query, sessionId, materials });
        },
      );
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, enabled, query, sessionId, revision]);
  if (!enabled) return undefined;
  const listed =
    listing?.query === query && listing.sessionId === sessionId ? listing.materials : [];
  return materialMentionCandidates(listed, new Set(staged.map((material) => material.materialId)));
}
