'use client';

/**
 * AgentRosterPanel — who is in this classroom, and what each of them is like.
 *
 * Course-level content, not an app setting: the roster lives on the stage
 * document (`stage.generatedAgentConfigs`), and every edit here goes straight
 * into it through `useAgentRoster`. It is mounted from `RosterDialog`, opened
 * from the edit dock's global bar.
 *
 * One card per member, collapsed to a line and expanded to an editor. The lead
 * teacher is first and cannot be removed (the last-teacher guard lives in
 * `agent-ops`); AI classmates below it reorder and can leave the class.
 *
 * Colours: the chrome is theme tokens, so the panel reads correctly in both
 * themes. The one exception is each classmate's OWN colour, which is data on the
 * agent and therefore stays an inline value.
 */

import {
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Camera, ChevronDown, ChevronUp, Redo2, Undo2, UserMinus, UserPlus } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useStageStore } from '@/lib/store/stage';
import type { GeneratedAgentConfig } from '@/lib/types/stage';
import { useAgentRoster } from './useAgentRoster';
import { AvatarPicker } from './AvatarPicker';

const PERSONA_MAX = 2000;

interface RosterDraft {
  readonly agentId: string;
  readonly patch: Partial<GeneratedAgentConfig>;
}

type RegisterDraft = (key: string, read: () => RosterDraft | null) => () => void;

// ─── Avatar with camera overlay ──────────────────────────────────────────────

interface AvatarWithOverlayProps {
  readonly agent: GeneratedAgentConfig;
  readonly size: number;
  readonly ringColor: string;
  readonly onPickerOpen: () => void;
}

function AvatarWithOverlay({ agent, size, ringColor, onPickerOpen }: AvatarWithOverlayProps) {
  const [hovering, setHovering] = useState(false);
  return (
    <div
      className="relative shrink-0 cursor-pointer"
      style={{ width: size, height: size }}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onClick={(e) => {
        e.stopPropagation();
        onPickerOpen();
      }}
    >
      {/* Avatars are static public paths; the roster needs no image optimizer. */}
      <img
        src={agent.avatar}
        alt={agent.name}
        draggable={false}
        className="rounded-full object-cover"
        style={{ width: size, height: size, boxShadow: `0 0 0 2px ${ringColor}` }}
      />
      {hovering && (
        <div className="absolute inset-0 flex items-center justify-center rounded-full bg-zinc-900/45">
          <Camera className="size-3.5 text-white" />
        </div>
      )}
    </div>
  );
}

// ─── Inline editable name ────────────────────────────────────────────────────

interface EditableNameProps {
  readonly agentId: string;
  readonly draftKey: string;
  readonly value: string;
  readonly onCommit: (v: string) => void;
  readonly registerDraft: RegisterDraft;
  readonly className?: string;
}

function EditableName({
  agentId,
  draftKey,
  value,
  onCommit,
  registerDraft,
  className,
}: EditableNameProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const draftValueRef = useRef(value);
  const focusedRef = useRef(false);
  useEffect(() => {
    if (!focusedRef.current) draftValueRef.current = value;
  }, [value]);

  const handleBlur = useCallback(() => {
    const text = ref.current?.textContent?.trim() ?? '';
    if (text && text !== value) onCommit(text);
    else if (ref.current) ref.current.textContent = value;
  }, [value, onCommit]);
  const readDraft = useCallback((): RosterDraft | null => {
    // Immediate Radix closes can still read the live DOM; controlled owner
    // closes may already have detached it, in which case the input snapshot is
    // the durable owner-side copy.
    const name = (ref.current?.textContent ?? draftValueRef.current).trim();
    return name && name !== value ? { agentId, patch: { name } } : null;
  }, [agentId, value]);
  useEffect(() => registerDraft(draftKey, readDraft), [draftKey, readDraft, registerDraft]);

  return (
    <span
      ref={ref}
      data-testid="agent-roster-name"
      contentEditable
      suppressContentEditableWarning
      onInput={(event) => {
        draftValueRef.current = event.currentTarget.textContent ?? '';
      }}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onBlur={() => {
        focusedRef.current = false;
        handleBlur();
      }}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        'cursor-text rounded-[3px] outline-none',
        'hover:underline hover:decoration-primary/60 hover:decoration-dashed',
        'focus:shadow-[0_0_0_2px_var(--ring)]',
        className,
      )}
      style={{ minWidth: 10 }}
    >
      {value}
    </span>
  );
}

// ─── Persona textarea ─────────────────────────────────────────────────────────

interface PersonaEditorProps {
  readonly agentId: string;
  readonly value: string;
  readonly onUpdate: (id: string, persona: string) => void;
  readonly registerDraft: RegisterDraft;
}

function PersonaEditor({ agentId, value, onUpdate, registerDraft }: PersonaEditorProps) {
  const { t } = useI18n();
  const [prevValue, setPrevValue] = useState(value);
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);

  // Sync draft when value changes externally (e.g. undo/redo), but only when
  // not focused — avoids clobbering in-progress typing. Render-time state
  // update: React re-renders immediately with the new draft before painting.
  if (prevValue !== value && !focused) {
    setPrevValue(value);
    setDraft(value);
  }

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value.slice(0, PERSONA_MAX));
  };

  const handleBlur = useCallback(() => {
    setFocused(false);
    if (draft !== value) onUpdate(agentId, draft);
  }, [agentId, draft, onUpdate, value]);
  const readDraft = useCallback(
    (): RosterDraft | null => (draft !== value ? { agentId, patch: { persona: draft } } : null),
    [agentId, draft, value],
  );
  useEffect(
    () => registerDraft(`${agentId}:persona`, readDraft),
    [agentId, readDraft, registerDraft],
  );

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11.5px] font-semibold tracking-[0.01em] text-muted-foreground">
        {t('edit.roster.personaLabel')}
      </span>
      <textarea
        data-persona={agentId}
        value={draft}
        onChange={handleChange}
        onFocus={() => setFocused(true)}
        onBlur={handleBlur}
        rows={4}
        maxLength={PERSONA_MAX}
        placeholder={t('edit.roster.personaPlaceholder')}
        className="w-full min-w-0 resize-none rounded-[10px] border border-border bg-background px-3 py-2.5 text-[12.5px] leading-relaxed text-foreground outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/20"
      />
      <span className="self-end text-[10px] text-muted-foreground/70">
        {draft.length} / {PERSONA_MAX}
      </span>
    </div>
  );
}

// ─── Teacher card ─────────────────────────────────────────────────────────────

interface TeacherCardProps {
  readonly agent: GeneratedAgentConfig;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onUpdate: (id: string, patch: Partial<GeneratedAgentConfig>) => void;
  readonly registerDraft: RegisterDraft;
}

function TeacherCard({ agent, open, onToggle, onUpdate, registerDraft }: TeacherCardProps) {
  const { t } = useI18n();
  const [showAvatarPicker, setShowAvatarPicker] = useState(false);
  const personaPreview = agent.persona?.slice(0, 40) || t('edit.roster.noPersona');

  return (
    <div
      data-testid="agent-roster-card"
      className="mb-3 w-full min-w-0 shrink-0 overflow-hidden rounded-[13px] border border-primary/25 bg-gradient-to-b from-primary/[0.07] to-transparent"
    >
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key !== 'Enter' && event.key !== ' ') return;
          if (event.key === ' ') event.preventDefault();
          onToggle();
        }}
        className="flex cursor-pointer select-none items-center gap-3 px-3 py-[11px]"
      >
        <AvatarWithOverlay
          agent={agent}
          size={42}
          ringColor="var(--primary)"
          onPickerOpen={() => {
            if (!open) {
              onToggle();
              setShowAvatarPicker(true);
              return;
            }
            setShowAvatarPicker((v) => !v);
          }}
        />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <EditableName
              agentId={agent.id}
              draftKey={`${agent.id}:name`}
              value={agent.name || t('edit.roster.unnamed')}
              onCommit={(name) => onUpdate(agent.id, { name })}
              registerDraft={registerDraft}
              className="text-[13.5px] font-semibold text-foreground"
            />
            <span className="inline-flex items-center gap-0.5 rounded-full border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-[9.5px] font-semibold text-primary">
              <span aria-hidden="true">👑</span>
              {t('edit.roster.teacherBadge')}
            </span>
          </div>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={agent.persona}>
            {personaPreview}
          </p>
        </div>

        {open ? (
          <ChevronUp className="size-[17px] shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="size-[17px] shrink-0 text-muted-foreground" />
        )}
      </div>

      {open && (
        <div className="flex flex-col gap-3 border-t border-primary/15 bg-primary/[0.03] px-3 pb-3 pt-3">
          {showAvatarPicker && (
            <div className="pb-1">
              <AvatarPicker
                value={agent.avatar}
                onChange={(avatar) => {
                  onUpdate(agent.id, { avatar });
                  setShowAvatarPicker(false);
                }}
              />
            </div>
          )}
          <PersonaEditor
            agentId={agent.id}
            value={agent.persona ?? ''}
            onUpdate={(id, persona) => onUpdate(id, { persona })}
            registerDraft={registerDraft}
          />
        </div>
      )}
    </div>
  );
}

// ─── Classmate card ────────────────────────────────────────────────────────────

interface ClassmateCardProps {
  readonly agent: GeneratedAgentConfig;
  readonly open: boolean;
  readonly isFirst: boolean;
  readonly isLast: boolean;
  readonly onToggle: () => void;
  readonly onUpdate: (id: string, patch: Partial<GeneratedAgentConfig>) => void;
  readonly onRemove: (id: string) => void;
  readonly onMoveUp: () => void;
  readonly onMoveDown: () => void;
  readonly registerDraft: RegisterDraft;
}

function ClassmateCard({
  agent,
  open,
  isFirst,
  isLast,
  onToggle,
  onUpdate,
  onRemove,
  onMoveUp,
  onMoveDown,
  registerDraft,
}: ClassmateCardProps) {
  const { t } = useI18n();
  const [showAvatarPicker, setShowAvatarPicker] = useState(false);
  // The agent's own colour is data, so it stays an inline value; everything
  // around it is a theme token.
  const ringColor = agent.color || 'var(--muted-foreground)';
  const personaPreview = agent.persona?.slice(0, 35) || t('edit.roster.noPersona');

  return (
    <div
      data-testid="agent-roster-card"
      className={cn(
        'group/card mb-[9px] w-full min-w-0 shrink-0 overflow-hidden rounded-[13px] border bg-card transition-colors',
        open ? 'border-transparent' : 'border-border',
      )}
      style={open ? { borderColor: `${ringColor}66`, boxShadow: `0 2px 12px ${ringColor}22` } : {}}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key !== 'Enter' && event.key !== ' ') return;
          if (event.key === ' ') event.preventDefault();
          onToggle();
        }}
        className="flex cursor-pointer select-none items-center gap-3 px-3 py-[11px]"
      >
        <AvatarWithOverlay
          agent={agent}
          size={40}
          ringColor={ringColor}
          onPickerOpen={() => {
            if (!open) {
              onToggle();
              setShowAvatarPicker(true);
              return;
            }
            setShowAvatarPicker((v) => !v);
          }}
        />

        <div className="min-w-0 flex-1">
          <EditableName
            agentId={agent.id}
            draftKey={`${agent.id}:name`}
            value={agent.name || t('edit.roster.unnamed')}
            onCommit={(name) => onUpdate(agent.id, { name })}
            registerDraft={registerDraft}
            className="block truncate text-[13.5px] font-semibold text-foreground"
          />
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={agent.persona}>
            {personaPreview}
          </p>
        </div>

        {/* Reorder controls: quiet at rest so the row is not two chevron stacks,
            and brought up on hover / keyboard focus. Kept rendered (not hidden)
            so they stay reachable without a pointer. Stop propagation so they
            don't expand the card. */}
        <div
          className="flex shrink-0 flex-col gap-0.5 opacity-45 transition-opacity duration-150 group-hover/card:opacity-100 focus-within:opacity-100 motion-reduce:transition-none"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            aria-label={t('edit.roster.moveUp')}
            disabled={isFirst}
            onClick={onMoveUp}
            className="grid size-5 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-25"
          >
            <ChevronUp className="size-3" />
          </button>
          <button
            type="button"
            aria-label={t('edit.roster.moveDown')}
            disabled={isLast}
            onClick={onMoveDown}
            className="grid size-5 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-25"
          >
            <ChevronDown className="size-3" />
          </button>
        </div>

        {open ? (
          <ChevronUp className="size-[17px] shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="size-[17px] shrink-0 text-muted-foreground" />
        )}
      </div>

      {open && (
        <div
          className="flex flex-col gap-3 border-t px-3 pb-3 pt-3"
          style={{ borderColor: `${ringColor}44`, background: `${ringColor}08` }}
        >
          {showAvatarPicker && (
            <div className="pb-1">
              <AvatarPicker
                value={agent.avatar}
                onChange={(avatar) => {
                  onUpdate(agent.id, { avatar });
                  setShowAvatarPicker(false);
                }}
              />
            </div>
          )}
          <PersonaEditor
            agentId={agent.id}
            value={agent.persona ?? ''}
            onUpdate={(id, persona) => onUpdate(id, { persona })}
            registerDraft={registerDraft}
          />

          <div className="mt-1 flex items-center justify-end border-t border-border pt-1">
            <button
              type="button"
              data-testid="agent-roster-remove"
              onClick={() => onRemove(agent.id)}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/15 dark:hover:text-rose-400"
            >
              <UserMinus className="size-3.5" />
              {t('edit.roster.removeFromClass')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export interface AgentRosterPanelHandle {
  flushDrafts(): void;
}

interface AgentRosterPanelProps {
  readonly flushRef?: Ref<AgentRosterPanelHandle>;
  /**
   * A control the host slots at the end of the sub-head row (the dialog's close
   * button). Rendered inline with undo/redo so it shares their baseline and ghost
   * icon skin instead of floating over the corner as a boxed glyph.
   */
  readonly headerTrailing?: ReactNode;
}

export function AgentRosterPanel({ flushRef, headerTrailing }: AgentRosterPanelProps = {}) {
  const { t } = useI18n();
  const { roster, selectedId, select, add, update, remove, reorder, history } = useAgentRoster();
  const setStageAgents = useStageStore.use.setStageAgents();
  const rosterRef = useRef(roster);
  useLayoutEffect(() => {
    rosterRef.current = roster;
  }, [roster]);
  const draftReaders = useRef(new Map<string, () => RosterDraft | null>());
  const registerDraft = useCallback<RegisterDraft>((key, read) => {
    draftReaders.current.set(key, read);
    return () => {
      if (draftReaders.current.get(key) === read) draftReaders.current.delete(key);
    };
  }, []);
  useImperativeHandle(
    flushRef,
    () => ({
      flushDrafts: () => {
        let next = rosterRef.current;
        for (const read of draftReaders.current.values()) {
          const draft = read();
          if (!draft) continue;
          next = next.map((agent) =>
            agent.id === draft.agentId ? { ...agent, ...draft.patch } : agent,
          );
        }
        if (next !== rosterRef.current) {
          // Commit synchronously to the owner store. A state update in an
          // unmount cleanup would never reach useAgentRoster's persistence
          // effect, which is precisely the close path this handle protects.
          rosterRef.current = next;
          setStageAgents(next);
        }
      },
    }),
    [setStageAgents],
  );

  const teachers = roster.filter((a) => a.role === 'teacher');
  const classmates = roster.filter((a) => a.role !== 'teacher');

  const handleUpdate = useCallback(
    (id: string, patch: Partial<GeneratedAgentConfig>) => {
      update(id, patch as Parameters<typeof update>[1]);
    },
    [update],
  );

  const handleToggle = (id: string) => {
    select(selectedId === id ? null : id);
  };

  // Reorder indices are within the full roster array
  const classmateGlobalIndex = (localIdx: number) =>
    roster.findIndex((a) => a.id === classmates[localIdx]?.id);

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col">
      {/* Sub-head: title + count on the left; the edit hint, undo/redo and the
          host's close button on the right, all sharing one baseline and one
          ghost-icon skin. */}
      <div className="flex shrink-0 items-center gap-1.5 px-4 pb-1.5 pt-3.5">
        <span className="text-[13px] font-semibold text-foreground">{t('edit.roster.title')}</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {t('edit.roster.count', { count: roster.length })}
        </span>
        <span className="flex-1" />
        <span className="text-[11px] text-muted-foreground">{t('edit.roster.editHint')}</span>
        <button
          type="button"
          title={t('edit.undo')}
          aria-label={t('edit.undo')}
          disabled={!history.canUndo}
          onClick={history.undo}
          className="ml-1 grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
        >
          <Undo2 className="size-3.5" />
        </button>
        <button
          type="button"
          title={t('edit.redo')}
          aria-label={t('edit.redo')}
          disabled={!history.canRedo}
          onClick={history.redo}
          className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
        >
          <Redo2 className="size-3.5" />
        </button>
        {headerTrailing}
      </div>

      {/* Scrollable list */}
      <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-y-auto px-3 pb-4">
        {teachers.map((agent) => (
          <TeacherCard
            key={agent.id}
            agent={agent}
            open={selectedId === agent.id}
            onToggle={() => handleToggle(agent.id)}
            onUpdate={handleUpdate}
            registerDraft={registerDraft}
          />
        ))}

        {classmates.length > 0 && (
          <div className="mb-2 flex items-center gap-2 px-0.5">
            <span className="whitespace-nowrap text-[10.5px] font-semibold tracking-[0.04em] text-muted-foreground">
              {t('edit.roster.aiClassmates', { count: classmates.length })}
            </span>
            <div className="flex-1 border-t border-border" />
          </div>
        )}

        {classmates.map((agent, localIdx) => {
          const globalIdx = classmateGlobalIndex(localIdx);
          return (
            <ClassmateCard
              key={agent.id}
              agent={agent}
              open={selectedId === agent.id}
              isFirst={localIdx === 0}
              isLast={localIdx === classmates.length - 1}
              onToggle={() => handleToggle(agent.id)}
              onUpdate={handleUpdate}
              onRemove={remove}
              onMoveUp={() => reorder(agent.id, globalIdx - 1)}
              onMoveDown={() => reorder(agent.id, globalIdx + 1)}
              registerDraft={registerDraft}
            />
          );
        })}

        <button
          type="button"
          data-testid="agent-roster-add"
          // `add` selects the new member itself, so the card opens on its own.
          onClick={() => add('student')}
          className="flex w-full items-center justify-center gap-2 rounded-[13px] border-[1.5px] border-dashed border-border py-3 text-[12.5px] text-muted-foreground transition-colors hover:border-primary/50 hover:bg-primary/5 hover:text-primary"
        >
          <UserPlus className="size-4" />
          {t('edit.roster.addRole')}
        </button>
      </div>
    </div>
  );
}
