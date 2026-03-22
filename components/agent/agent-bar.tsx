'use client';

import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import { resolveAgentVoice, getAvailableProvidersWithVoices } from '@/lib/audio/voice-resolver';
import { Sparkles, ChevronDown, ChevronUp, Shuffle, Volume2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { TTSProviderId } from '@/lib/audio/types';

function AgentVoicePill({
  agent,
  agentIndex,
  availableProviders,
  globalProviderId,
}: {
  agent: AgentConfig;
  agentIndex: number;
  availableProviders: ReturnType<typeof getAvailableProvidersWithVoices>;
  globalProviderId: TTSProviderId;
}) {
  const updateAgent = useAgentRegistry((s) => s.updateAgent);
  const resolved = resolveAgentVoice(agent, globalProviderId, agentIndex);

  // Encode as "providerId::voiceId" for the Select value
  const currentValue = `${resolved.providerId}::${resolved.voiceId}`;

  // Find display name for current voice
  const currentVoiceName = (() => {
    for (const p of availableProviders) {
      const v = p.voices.find((voice) => voice.id === resolved.voiceId);
      if (v) return v.name;
    }
    return resolved.voiceId;
  })();

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      className="shrink-0"
    >
      <Select
        value={currentValue}
        onValueChange={(value) => {
          const [providerId, voiceId] = value.split('::');
          updateAgent(agent.id, {
            voiceConfig: { providerId: providerId as TTSProviderId, voiceId },
          });
        }}
      >
        <SelectTrigger className="h-5 w-auto rounded-full border-0 bg-muted/60 px-2 text-[10px] text-muted-foreground/70 hover:bg-muted hover:text-muted-foreground shadow-none focus:ring-0 [&>svg]:size-2.5 [&>svg]:text-muted-foreground/40 gap-0.5">
          <Volume2 className="size-2.5 shrink-0" />
          <span className="truncate max-w-[56px]">{currentVoiceName}</span>
        </SelectTrigger>
        <SelectContent>
          {availableProviders.map((provider) => (
            <SelectGroup key={provider.providerId}>
              <SelectLabel className="text-[10px] text-muted-foreground/60 px-2 py-1">
                {provider.providerName}
              </SelectLabel>
              {provider.voices.map((voice) => (
                <SelectItem
                  key={`${provider.providerId}::${voice.id}`}
                  value={`${provider.providerId}::${voice.id}`}
                  className="text-xs"
                >
                  {voice.name}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function AgentBar() {
  const { t } = useI18n();
  const { listAgents } = useAgentRegistry();
  const selectedAgentIds = useSettingsStore((s) => s.selectedAgentIds);
  const setSelectedAgentIds = useSettingsStore((s) => s.setSelectedAgentIds);
  const maxTurns = useSettingsStore((s) => s.maxTurns);
  const setMaxTurns = useSettingsStore((s) => s.setMaxTurns);
  const agentMode = useSettingsStore((s) => s.agentMode);
  const setAgentMode = useSettingsStore((s) => s.setAgentMode);
  const ttsProviderId = useSettingsStore((s) => s.ttsProviderId);
  const ttsProvidersConfig = useSettingsStore((s) => s.ttsProvidersConfig);
  const ttsMuted = useSettingsStore((s) => s.ttsMuted);

  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const allAgents = listAgents();
  const agents = allAgents.filter((a) => !a.isGenerated);
  const teacherAgent = agents.find((a) => a.role === 'teacher');
  const selectedAgents = agents.filter((a) => selectedAgentIds.includes(a.id));
  const nonTeacherSelected = selectedAgents.filter((a) => a.role !== 'teacher');

  const availableProviders = getAvailableProvidersWithVoices(ttsProvidersConfig);
  const showVoice = availableProviders.length > 0;

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleModeChange = (mode: 'preset' | 'auto') => {
    setAgentMode(mode);
    if (mode === 'preset') {
      const hasTeacherSelected = selectedAgentIds.some((id) => {
        const a = agents.find((agent) => agent.id === id);
        return a?.role === 'teacher';
      });
      if (!hasTeacherSelected && teacherAgent) {
        setSelectedAgentIds([teacherAgent.id, ...selectedAgentIds]);
      }
    }
  };

  const toggleAgent = (agentId: string) => {
    const agent = agents.find((a) => a.id === agentId);
    if (agent?.role === 'teacher') return;
    if (selectedAgentIds.includes(agentId)) {
      setSelectedAgentIds(selectedAgentIds.filter((id) => id !== agentId));
    } else {
      setSelectedAgentIds([...selectedAgentIds, agentId]);
    }
  };

  const getAgentName = (agent: { id: string; name: string }) => {
    const key = `settings.agentNames.${agent.id}`;
    const translated = t(key);
    return translated !== key ? translated : agent.name;
  };

  const getAgentRole = (agent: { role: string }) => {
    const key = `settings.agentRoles.${agent.role}`;
    const translated = t(key);
    return translated !== key ? translated : agent.role;
  };

  const avatarRow = (
    <div className="flex items-center gap-1.5 shrink-0">
      {teacherAgent && (
        <div className="size-8 rounded-full overflow-hidden ring-2 ring-blue-400/40 dark:ring-blue-500/30 shrink-0">
          <img
            src={teacherAgent.avatar}
            alt={getAgentName(teacherAgent)}
            className="size-full object-cover"
          />
        </div>
      )}

      {agentMode === 'auto' ? (
        <>
          <div className="flex -space-x-2">
            {agents.find((a) => a.role === 'assistant') && (
              <div className="size-6 rounded-full overflow-hidden ring-[1.5px] ring-background">
                <img
                  src={agents.find((a) => a.role === 'assistant')!.avatar}
                  alt=""
                  className="size-full object-cover"
                />
              </div>
            )}
          </div>
          <Shuffle className="size-4 text-violet-400 dark:text-violet-500" />
        </>
      ) : (
        <>
          {nonTeacherSelected.length > 0 && (
            <div className="flex -space-x-2">
              {nonTeacherSelected.slice(0, 4).map((agent) => (
                <div
                  key={agent.id}
                  className="size-6 rounded-full overflow-hidden ring-[1.5px] ring-background"
                >
                  <img
                    src={agent.avatar}
                    alt={getAgentName(agent)}
                    className="size-full object-cover"
                  />
                </div>
              ))}
              {nonTeacherSelected.length > 4 && (
                <div className="size-6 rounded-full bg-muted ring-[1.5px] ring-background flex items-center justify-center">
                  <span className="text-[9px] font-bold text-muted-foreground">
                    +{nonTeacherSelected.length - 4}
                  </span>
                </div>
              )}
            </div>
          )}
        </>
      )}
      {showVoice && (
        <Volume2 className="size-3.5 text-muted-foreground/40 group-hover:text-muted-foreground/60 transition-colors" />
      )}
    </div>
  );

  return (
    <div ref={containerRef} className="relative w-80">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            className={cn(
              'group flex items-center gap-2 cursor-pointer rounded-full px-2.5 py-2 transition-all w-full',
              'border border-border/50 text-muted-foreground/70 hover:text-foreground hover:bg-muted/60',
            )}
            onClick={() => setOpen(!open)}
          >
            <span className="text-xs text-muted-foreground/60 group-hover:text-muted-foreground transition-colors hidden sm:block font-medium flex-1 text-left truncate">
              {open ? t('agentBar.expandedTitle') : t('agentBar.readyToLearn')}
            </span>
            {avatarRow}
            {open ? (
              <ChevronUp className="size-3 text-muted-foreground/40 group-hover:text-muted-foreground/70 transition-colors" />
            ) : (
              <ChevronDown className="size-3 text-muted-foreground/40 group-hover:text-muted-foreground/70 transition-colors" />
            )}
          </button>
        </TooltipTrigger>
        {!open && (
          <TooltipContent side="bottom" sideOffset={4}>
            {t('agentBar.configTooltip')}
          </TooltipContent>
        )}
      </Tooltip>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.97 }}
            transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
            className="absolute right-0 top-full mt-1 z-50 w-80"
          >
            <div className="rounded-2xl bg-white/95 dark:bg-slate-800/95 backdrop-blur-sm ring-1 ring-black/[0.04] dark:ring-white/[0.06] shadow-[0_1px_8px_-2px_rgba(0,0,0,0.06)] dark:shadow-[0_1px_8px_-2px_rgba(0,0,0,0.3)] px-2.5 py-2">
              {/* Mode tabs */}
              <div className="flex rounded-lg border bg-muted/30 p-0.5 mb-2.5">
                <button
                  onClick={() => handleModeChange('preset')}
                  className={cn(
                    'flex-1 py-1.5 text-xs font-medium rounded-md transition-all text-center',
                    agentMode === 'preset'
                      ? 'bg-background shadow-sm text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {t('settings.agentModePreset')}
                </button>
                <button
                  onClick={() => handleModeChange('auto')}
                  className={cn(
                    'flex-1 py-1.5 text-xs font-medium rounded-md transition-all text-center flex items-center justify-center gap-1',
                    agentMode === 'auto'
                      ? 'bg-background shadow-sm text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Sparkles className="h-3 w-3" />
                  {t('settings.agentModeAuto')}
                </button>
              </div>

              {agentMode === 'preset' ? (
                <div className="max-h-72 overflow-y-auto -mx-1">
                  {/* Teacher row */}
                  {teacherAgent && (
                    <div className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg bg-primary/5">
                      <Checkbox checked disabled className="pointer-events-none opacity-50" />
                      <div
                        className="size-7 rounded-full overflow-hidden shrink-0 ring-1 ring-border/40"
                        style={{ boxShadow: `0 0 0 2px ${teacherAgent.color}30` }}
                      >
                        <img
                          src={teacherAgent.avatar}
                          alt={getAgentName(teacherAgent)}
                          className="size-full object-cover"
                        />
                      </div>
                      <span className="text-sm font-medium truncate min-w-0 flex-1">
                        {getAgentName(teacherAgent)}
                      </span>
                      <span className="text-[10px] text-muted-foreground/50 w-14 text-right shrink-0">
                        {getAgentRole(teacherAgent)}
                      </span>
                      {showVoice && (
                        <AgentVoicePill
                          agent={teacherAgent}
                          agentIndex={0}
                          availableProviders={availableProviders}
                          globalProviderId={ttsProviderId}
                        />
                      )}
                    </div>
                  )}

                  {/* Non-teacher agents */}
                  {agents
                    .filter((a) => a.role !== 'teacher')
                    .map((agent, idx) => {
                      const isSelected = selectedAgentIds.includes(agent.id);
                      const agentIndex = idx + 1;
                      return (
                        <div
                          key={agent.id}
                          onClick={() => toggleAgent(agent.id)}
                          className={cn(
                            'w-full flex items-center gap-2.5 px-3 py-1.5 cursor-pointer rounded-lg transition-colors',
                            isSelected ? 'bg-primary/5' : 'hover:bg-muted/50',
                          )}
                        >
                          <Checkbox checked={isSelected} className="pointer-events-none" />
                          <div
                            className="size-7 rounded-full overflow-hidden shrink-0 ring-1 ring-border/40"
                            style={{
                              boxShadow: isSelected ? `0 0 0 2px ${agent.color}30` : undefined,
                            }}
                          >
                            <img
                              src={agent.avatar}
                              alt={getAgentName(agent)}
                              className="size-full object-cover"
                            />
                          </div>
                          <span className="text-sm font-medium truncate min-w-0 flex-1">
                            {getAgentName(agent)}
                          </span>
                          <span className="text-[10px] text-muted-foreground/50 w-14 text-right shrink-0">
                            {getAgentRole(agent)}
                          </span>
                          {showVoice && (
                            <AgentVoicePill
                              agent={agent}
                              agentIndex={agentIndex}
                              availableProviders={availableProviders}
                              globalProviderId={ttsProviderId}
                            />
                          )}
                        </div>
                      );
                    })}
                </div>
              ) : (
                <div className="flex flex-col items-center pt-6 pb-2 gap-8">
                  <div className="relative flex items-center justify-center">
                    <div className="absolute size-12 rounded-full bg-violet-400/10 dark:bg-violet-400/15 animate-ping [animation-duration:3s]" />
                    <div className="absolute size-14 rounded-full bg-violet-400/5 dark:bg-violet-400/10 animate-pulse [animation-duration:2.5s]" />
                    <Shuffle className="relative size-7 text-violet-400 dark:text-violet-500" />
                  </div>
                  <p className="text-xs text-muted-foreground text-center">
                    {t('settings.agentModeAutoDesc')}
                  </p>
                  <p className="text-[11px] text-muted-foreground/50 text-center -mt-4">
                    {t('agentBar.voiceAutoAssign')}
                  </p>
                </div>
              )}

              {/* Max turns */}
              <div className="pt-2.5 mt-2.5 border-t flex items-center gap-3">
                <span className="text-xs text-muted-foreground shrink-0">
                  {t('settings.maxTurns')}
                </span>
                <Input
                  type="number"
                  min="1"
                  max="20"
                  value={maxTurns}
                  onChange={(e) => setMaxTurns(e.target.value)}
                  className="w-16 h-7 text-xs"
                />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
