'use client';

import type { ReactNode } from 'react';
import { CommandBar } from '@/components/edit/EditShell/CommandBar';
import { AgentRosterGrid } from './AgentRosterGrid';
import { AgentInspector } from './AgentInspector';
import { useAgentRoster } from './useAgentRoster';

interface AgentsViewProps {
  /**
   * Right-edge slot of CommandBar — receives the HeaderControls (settings pill
   * + Pro Switch) forwarded from EditChromeRoot, keeping chrome layout
   * consistent between slides and agents modes.
   */
  readonly commandTrailing?: ReactNode;
  /**
   * Center slot of CommandBar — receives the [Slides]/[Agents] view toggle
   * forwarded from EditChromeRoot.
   */
  readonly commandLeading?: ReactNode;
}

/**
 * Agents-mode view — replaces EditShell when viewMode === 'agents'.
 *
 * Layout:
 *   ┌─────────────────────────────────────────┐
 *   │ CommandBar (title="Agents", undo/redo)  │
 *   ├──────────────────────┬──────────────────┤
 *   │ AgentRosterGrid      │ AgentInspector   │
 *   │ (scrollable)         │ (selected agent) │
 *   └──────────────────────┴──────────────────┘
 */
export function AgentsView({ commandTrailing, commandLeading }: AgentsViewProps) {
  const controller = useAgentRoster();
  const { roster, selectedId, select, add, update, remove, reorder, canRemove, canChangeRole, history } =
    controller;

  const selectedAgent = selectedId ? roster.find((a) => a.id === selectedId) : undefined;

  return (
    <div className="flex h-full flex-col">
      <CommandBar
        title="Agents"
        history={history}
        leading={commandLeading}
        trailing={commandTrailing}
      />
      <div
        className="flex flex-1 overflow-hidden bg-zinc-50/40 dark:bg-zinc-950/30"
        style={{
          backgroundImage: 'radial-gradient(circle, rgba(113,113,122,0.10) 1px, transparent 1px)',
          backgroundSize: '22px 22px',
        }}
      >
        <AgentRosterGrid
          roster={roster}
          selectedId={selectedId}
          onSelect={select}
          onAdd={add}
          onRemove={remove}
          onReorder={reorder}
          canRemove={canRemove}
        />
        {selectedAgent && (
          <AgentInspector
            agent={selectedAgent}
            onUpdate={(patch) => update(selectedAgent.id, patch)}
            canChangeRole={canChangeRole}
          />
        )}
      </div>
    </div>
  );
}
