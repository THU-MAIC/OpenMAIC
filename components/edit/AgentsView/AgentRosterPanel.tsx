'use client';

import { useState, useRef, useCallback } from 'react';
import { Camera, ChevronDown, ChevronUp, Redo2, Undo2, UserMinus, UserPlus } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { GeneratedAgentConfig } from '@/lib/types/stage';
import { useAgentRoster } from './useAgentRoster';
import { AvatarPicker } from './AvatarPicker';

const PERSONA_MAX = 2000;

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
      <img
        src={agent.avatar}
        alt={agent.name}
        draggable={false}
        className="rounded-full object-cover"
        style={{ width: size, height: size, boxShadow: `0 0 0 2px ${ringColor}` }}
      />
      {hovering && (
        <div
          className="absolute inset-0 flex items-center justify-center rounded-full"
          style={{ background: 'rgba(24,24,27,.45)' }}
        >
          <Camera className="text-white" style={{ width: 14, height: 14 }} />
        </div>
      )}
    </div>
  );
}

// ─── Inline editable name ────────────────────────────────────────────────────

interface EditableNameProps {
  readonly value: string;
  readonly onCommit: (v: string) => void;
  readonly className?: string;
}

function EditableName({ value, onCommit, className }: EditableNameProps) {
  const ref = useRef<HTMLSpanElement>(null);

  const handleBlur = useCallback(() => {
    const text = ref.current?.textContent?.trim() ?? '';
    if (text && text !== value) onCommit(text);
    else if (ref.current) ref.current.textContent = value;
  }, [value, onCommit]);

  return (
    <span
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      onBlur={handleBlur}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        'outline-none cursor-text rounded-[3px]',
        'hover:underline hover:decoration-dashed hover:decoration-[#b08ee6]',
        'focus:shadow-[0_0_0_2px_rgba(114,46,209,.18)]',
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
  readonly borderColor: string;
  readonly onUpdate: (id: string, persona: string) => void;
}

function PersonaEditor({ agentId, value, borderColor, onUpdate }: PersonaEditorProps) {
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
    const v = e.target.value.slice(0, PERSONA_MAX);
    setDraft(v);
  };

  const handleFocus = () => setFocused(true);

  const handleBlur = () => {
    setFocused(false);
    if (draft !== value) onUpdate(agentId, draft);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span style={{ fontSize: 11.5, fontWeight: 600, color: '#52525b', letterSpacing: '.01em' }}>
        人设描述
      </span>
      <textarea
        data-persona={agentId}
        value={draft}
        onChange={handleChange}
        onFocus={handleFocus}
        onBlur={handleBlur}
        rows={4}
        maxLength={PERSONA_MAX}
        placeholder="描述角色的性格、教学风格与任务…"
        className="resize-none rounded-[10px] bg-white px-3 py-2.5 outline-none focus:ring-1"
        style={{
          border: `1px solid ${borderColor}`,
          fontSize: 12.5,
          lineHeight: 1.7,
          color: '#3f3f46',
          // focus ring uses the same tint as border
        }}
      />
      <span style={{ fontSize: 10, color: '#a1a1aa', alignSelf: 'flex-end' }}>
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
}

function TeacherCard({ agent, open, onToggle, onUpdate }: TeacherCardProps) {
  const [showAvatarPicker, setShowAvatarPicker] = useState(false);
  const personaPreview = agent.persona?.slice(0, 40) || '暂无人设';

  return (
    <div
      className="mb-3"
      style={{
        borderRadius: 13,
        border: '1px solid #e9d8fb',
        background: 'linear-gradient(180deg,#faf6ff,#fff)',
        overflow: 'hidden',
      }}
    >
      {/* Card head */}
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onToggle()}
        className="flex cursor-pointer items-center gap-3 px-3 py-[11px] select-none"
      >
        <AvatarWithOverlay
          agent={agent}
          size={42}
          ringColor="#722ed1"
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
          <div className="flex items-center gap-2 flex-wrap">
            <EditableName
              value={agent.name || '未命名'}
              onCommit={(name) => onUpdate(agent.id, { name })}
              className="text-[13.5px] font-semibold text-[#27272a]"
            />
            {/* 主讲 badge */}
            <span
              className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5"
              style={{
                background: '#f5f0fd',
                border: '1px solid #e9d8fb',
                fontSize: 9.5,
                fontWeight: 600,
                color: '#5b1fa8',
              }}
            >
              👑 主讲
            </span>
          </div>
          <p
            className="mt-0.5 truncate"
            style={{ fontSize: 11, color: '#a1a1aa' }}
            title={agent.persona || ''}
          >
            {personaPreview}
          </p>
        </div>

        {open ? (
          <ChevronUp style={{ width: 17, height: 17, color: '#a1a1aa', flexShrink: 0 }} />
        ) : (
          <ChevronDown style={{ width: 17, height: 17, color: '#a1a1aa', flexShrink: 0 }} />
        )}
      </div>

      {/* Expanded editor */}
      {open && (
        <div
          className="flex flex-col gap-3 px-3 pb-3"
          style={{ borderTop: '1px solid #efe4fb', paddingTop: 12, background: '#fdfaff' }}
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
            borderColor="#e9d8fb"
            onUpdate={(id, persona) => onUpdate(id, { persona })}
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
}: ClassmateCardProps) {
  const [showAvatarPicker, setShowAvatarPicker] = useState(false);
  const ringColor = agent.color || '#a1a1aa';
  const personaPreview = agent.persona?.slice(0, 35) || '暂无人设';

  return (
    <div
      className="mb-[9px]"
      style={{
        borderRadius: 13,
        border: open ? `1px solid ${ringColor}66` : '1px solid #f0f0f2',
        background: '#fff',
        boxShadow: open ? `0 2px 12px ${ringColor}22` : undefined,
        overflow: 'hidden',
        transition: 'border-color .15s, box-shadow .15s',
      }}
    >
      {/* Card head */}
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onToggle()}
        className="flex cursor-pointer items-center gap-3 px-3 py-[11px] select-none"
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
            value={agent.name || '未命名'}
            onCommit={(name) => onUpdate(agent.id, { name })}
            className="block truncate text-[13.5px] font-semibold text-[#27272a]"
          />
          <p
            className="mt-0.5 truncate"
            style={{ fontSize: 11, color: '#a1a1aa' }}
            title={agent.persona || ''}
          >
            {personaPreview}
          </p>
        </div>

        {/* Reorder controls (stop propagation so they don't expand) */}
        <div className="flex flex-col gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            aria-label="上移"
            disabled={isFirst}
            onClick={onMoveUp}
            className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-zinc-100 disabled:pointer-events-none disabled:opacity-25"
          >
            <ChevronUp style={{ width: 12, height: 12, color: '#a1a1aa' }} />
          </button>
          <button
            type="button"
            aria-label="下移"
            disabled={isLast}
            onClick={onMoveDown}
            className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-zinc-100 disabled:pointer-events-none disabled:opacity-25"
          >
            <ChevronDown style={{ width: 12, height: 12, color: '#a1a1aa' }} />
          </button>
        </div>

        {open ? (
          <ChevronUp style={{ width: 17, height: 17, color: '#a1a1aa', flexShrink: 0 }} />
        ) : (
          <ChevronDown style={{ width: 17, height: 17, color: '#a1a1aa', flexShrink: 0 }} />
        )}
      </div>

      {/* Expanded editor */}
      {open && (
        <div
          className="flex flex-col gap-3 px-3 pb-3"
          style={{
            borderTop: `1px solid ${ringColor}44`,
            paddingTop: 12,
            background: `${ringColor}08`,
          }}
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
            borderColor={`${ringColor}66`}
            onUpdate={(id, persona) => onUpdate(id, { persona })}
          />

          {/* Footer: remove */}
          <div
            className="flex items-center justify-end pt-1"
            style={{ borderTop: '1px solid #f0f0f2', marginTop: 4 }}
          >
            <button
              type="button"
              onClick={() => onRemove(agent.id)}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-rose-50 hover:text-rose-600"
              style={{ fontSize: 11.5, color: '#71717a' }}
            >
              <UserMinus style={{ width: 13, height: 13 }} />
              移出课堂
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export function AgentRosterPanel() {
  const { roster, selectedId, select, add, update, remove, reorder, history } = useAgentRoster();

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

  const handleAdd = () => {
    add('student');
    // select() called inside add() already
  };

  // Reorder indices are within the full roster array
  const classmateGlobalIndex = (localIdx: number) =>
    roster.findIndex((a) => a.id === classmates[localIdx]?.id);

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      {/* Sub-head */}
      <div
        className="flex shrink-0 items-baseline gap-1.5 px-4 pb-1.5"
        style={{ paddingTop: 14, paddingBottom: 6 }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: '#3f3f46' }}>课堂阵容</span>
        <span style={{ fontSize: 11, color: '#a1a1aa', fontFamily: 'monospace' }}>
          {roster.length} 位
        </span>
        <span className="flex-1" />
        <span style={{ fontSize: 11, color: '#a1a1aa' }}>点击一位展开编辑</span>
        {/* Undo/redo */}
        <button
          type="button"
          title="撤销"
          aria-label="撤销"
          disabled={!history.canUndo}
          onClick={history.undo}
          className="ml-1 grid size-5 place-items-center rounded text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 disabled:pointer-events-none disabled:opacity-30"
        >
          <Undo2 style={{ width: 12, height: 12 }} />
        </button>
        <button
          type="button"
          title="重做"
          aria-label="重做"
          disabled={!history.canRedo}
          onClick={history.redo}
          className="grid size-5 place-items-center rounded text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 disabled:pointer-events-none disabled:opacity-30"
        >
          <Redo2 style={{ width: 12, height: 12 }} />
        </button>
      </div>

      {/* Scrollable list */}
      <div className="flex flex-1 min-h-0 flex-col overflow-y-auto px-3 pb-4">
        {/* Teacher cards */}
        {teachers.map((agent) => (
          <TeacherCard
            key={agent.id}
            agent={agent}
            open={selectedId === agent.id}
            onToggle={() => handleToggle(agent.id)}
            onUpdate={handleUpdate}
          />
        ))}

        {/* Divider */}
        {classmates.length > 0 && (
          <div className="mb-2 flex items-center gap-2 px-0.5">
            <span
              style={{
                fontSize: 10.5,
                fontWeight: 600,
                letterSpacing: '.04em',
                color: '#a1a1aa',
                whiteSpace: 'nowrap',
              }}
            >
              AI 同学 · {classmates.length}
            </span>
            <div className="flex-1 border-t" style={{ borderColor: '#f1f1f3' }} />
          </div>
        )}

        {/* Classmate cards */}
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
            />
          );
        })}

        {/* Add button */}
        <button
          type="button"
          onClick={handleAdd}
          className="flex w-full items-center justify-center gap-2 rounded-[13px] py-3 transition-colors"
          style={{
            border: '1.5px dashed #d4d4d8',
            fontSize: 12.5,
            color: '#71717a',
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.borderColor = '#9d63e3';
            (e.currentTarget as HTMLButtonElement).style.color = '#5b1fa8';
            (e.currentTarget as HTMLButtonElement).style.background = '#faf6ff';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.borderColor = '#d4d4d8';
            (e.currentTarget as HTMLButtonElement).style.color = '#71717a';
            (e.currentTarget as HTMLButtonElement).style.background = '';
          }}
        >
          <UserPlus style={{ width: 15, height: 15 }} />
          添加角色
        </button>
      </div>
    </div>
  );
}
