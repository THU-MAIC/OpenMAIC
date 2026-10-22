'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels';
import { useI18n } from '@/lib/hooks/use-i18n';

export function WorkbenchSplit({
  workspace,
  assistant,
  showWorkspace = true,
  showAssistant = true,
}: {
  workspace: ReactNode;
  assistant: ReactNode;
  showWorkspace?: boolean;
  showAssistant?: boolean;
}) {
  const workspacePanel = usePanelRef(),
    assistantPanel = usePanelRef();
  useEffect(() => {
    if (showWorkspace) workspacePanel.current?.expand();
    else workspacePanel.current?.collapse();
  }, [showWorkspace, workspacePanel]);
  useEffect(() => {
    if (showAssistant) assistantPanel.current?.expand();
    else assistantPanel.current?.collapse();
  }, [showAssistant, assistantPanel]);
  const ref = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const { t } = useI18n();
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setCompact(entry!.contentRect.width < 560));
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} className="min-h-0 flex-1 overflow-auto" data-testid="pbl-workbench-split">
      <Group
        orientation={compact ? 'vertical' : 'horizontal'}
        style={{ height: compact ? 1100 : '100%', minHeight: compact ? 1100 : 0 }}
      >
        <Panel
          id="workspace"
          panelRef={workspacePanel}
          collapsible
          defaultSize="55%"
          minSize={compact ? '350px' : '30%'}
          className="h-full min-w-0"
        >
          {workspace}
        </Panel>
        <Separator
          aria-label={t('pblV3.ide.resize')}
          className={compact ? 'h-1 bg-border hover:bg-primary' : 'w-1 bg-border hover:bg-primary'}
        />
        <Panel
          id="assistant"
          panelRef={assistantPanel}
          collapsible
          defaultSize="45%"
          minSize={compact ? '400px' : '28%'}
          className="h-full min-w-0"
        >
          {assistant}
        </Panel>
      </Group>
    </div>
  );
}
