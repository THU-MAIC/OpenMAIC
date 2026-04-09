'use client';

import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { AlertCircle, User, Users, Sparkles, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';

interface Agent {
  id: string;
  name: string;
  avatar: string;
  role: string;
  priority: number;
  allowedActions: string[];
}

interface AgentSettingsProps {
  agents: Agent[];
  selectedAgentIds: string[];
  maxTurns: string;
  agentMode: 'preset' | 'auto';
  onToggleAgent: (agentId: string) => void;
  onMaxTurnsChange: (value: string) => void;
  onAgentModeChange: (mode: 'preset' | 'auto') => void;
}

export function AgentSettings(_props: AgentSettingsProps) {
  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-start gap-2.5 p-3 rounded-lg bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 text-sm">
        <Info className="h-4 w-4 mt-0.5 shrink-0" />
        <span>Classroom role configuration is managed by the administrator.</span>
      </div>
    </div>
  );
}
