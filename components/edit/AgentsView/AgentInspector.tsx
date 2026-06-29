'use client';

import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AvatarPicker } from './AvatarPicker';
import type { GeneratedAgentConfig } from '@/lib/types/stage';
import type { AgentConfigPatch } from '@/lib/edit/agent-ops';

const PERSONA_MAX = 2000;

const FOCUS =
  'focus-visible:border-violet-400 focus-visible:ring-violet-400/25';

interface AgentInspectorProps {
  readonly agent: GeneratedAgentConfig;
  readonly onUpdate: (patch: AgentConfigPatch) => void;
}

/**
 * Right-panel inspector for the selected agent.
 * Allows editing name, role, avatar, and persona.
 */
export function AgentInspector({ agent, onUpdate }: AgentInspectorProps) {
  return (
    <div className="flex w-80 shrink-0 flex-col gap-0 border-l border-zinc-200/60 dark:border-zinc-800/60">
      {/* Header strip showing avatar + name */}
      <div className="flex items-center gap-3 border-b border-zinc-100 bg-zinc-50/60 px-5 py-4 dark:border-zinc-800/60 dark:bg-zinc-900/40">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-zinc-200/60 bg-white dark:border-zinc-700/60 dark:bg-zinc-800">
          <img src={agent.avatar} alt={agent.name} className="h-full w-full object-cover" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-zinc-800 dark:text-zinc-100">
            {agent.name || '未命名'}
          </p>
          <p className="text-xs text-zinc-400 dark:text-zinc-500">角色配置</p>
        </div>
      </div>

      {/* Form fields */}
      <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-5 py-5">
        {/* Name */}
        <Field label="名称">
          <Input
            value={agent.name}
            onChange={(e) => onUpdate({ name: e.target.value })}
            placeholder="角色名称"
            className={cn(FOCUS)}
          />
        </Field>

        {/* Role */}
        <Field label="角色">
          <Select
            value={agent.role}
            onValueChange={(v) => onUpdate({ role: v })}
          >
            <SelectTrigger className={cn('w-full', FOCUS)}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="teacher">教师</SelectItem>
              <SelectItem value="assistant">助教</SelectItem>
              <SelectItem value="student">学生</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        {/* Avatar */}
        <Field label="头像">
          <AvatarPicker
            value={agent.avatar}
            onChange={(avatar) => onUpdate({ avatar })}
          />
        </Field>

        {/* Persona */}
        <Field label={`人设 (${agent.persona.length} / ${PERSONA_MAX})`}>
          <Textarea
            value={agent.persona}
            onChange={(e) => {
              const val = e.target.value.slice(0, PERSONA_MAX);
              onUpdate({ persona: val });
            }}
            placeholder="描述角色的性格、教学风格与任务…"
            rows={6}
            maxLength={PERSONA_MAX}
            className={cn('resize-none', FOCUS)}
          />
        </Field>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
        {label}
      </span>
      {children}
    </div>
  );
}
