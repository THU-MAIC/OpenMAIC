'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels';
import { useI18n } from '@/lib/hooks/use-i18n';

export function WorkbenchSplit({
  workspace,
  assistant,
  application,
  showApplication = false,
  onCollapseApplication,
  showWorkspace = true,
  showAssistant = true,
}: {
  workspace: ReactNode;
  assistant: ReactNode;
  application?: ReactNode;
  showApplication?: boolean;
  onCollapseApplication?: () => void;
  showWorkspace?: boolean;
  showAssistant?: boolean;
}) {
  const hasApplication = !!application;
  const workspacePanel = usePanelRef(),
    assistantPanel = usePanelRef(),
    applicationPanel = usePanelRef();
  useEffect(() => {
    if (showWorkspace) workspacePanel.current?.expand();
    else workspacePanel.current?.collapse();
  }, [showWorkspace, workspacePanel]);
  useEffect(() => {
    if (showAssistant) assistantPanel.current?.expand();
    else assistantPanel.current?.collapse();
  }, [showAssistant, assistantPanel]);
  useEffect(() => {
    if (showApplication) applicationPanel.current?.expand();
    else applicationPanel.current?.collapse();
  }, [showApplication, applicationPanel, hasApplication]);
  const ref = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const { t } = useI18n();
  const visiblePanels =
    Number(showWorkspace) + Number(showAssistant) + Number(!!application && showApplication);
  const stacked = compact && visiblePanels > 1;
  const stackHeight =
    (!hasApplication && showWorkspace && showAssistant ? 10 : 0) +
    (showWorkspace ? 350 : 0) +
    (showAssistant ? 400 : 0) +
    (application && showApplication ? 380 : 0);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) =>
      setCompact(entry!.contentRect.width < (hasApplication && showApplication ? 1040 : 560)),
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [hasApplication, showApplication]);
  return (
    <div ref={ref} className="min-h-0 flex-1 overflow-auto" data-testid="pbl-workbench-split">
      <Group
        orientation={compact ? 'vertical' : 'horizontal'}
        onLayoutChanged={(layout, meta) => {
          if (meta.isUserInteraction && showApplication && layout.application === 0)
            onCollapseApplication?.();
        }}
        style={{ height: stacked ? stackHeight : '100%', minHeight: stacked ? stackHeight : 0 }}
      >
        <Panel
          id="workspace"
          panelRef={workspacePanel}
          collapsible
          defaultSize={application ? '39.6%' : '55%'}
          minSize={stacked ? '350px' : compact ? 0 : hasApplication ? '25%' : '30%'}
          className="h-full min-w-0"
        >
          {workspace}
        </Panel>
        {application && (
          <>
            <Separator
              aria-label={t('pblV3.ide.resize')}
              disabled={!showApplication}
              className={
                !showApplication
                  ? 'hidden'
                  : compact
                    ? 'h-1 bg-border hover:bg-primary'
                    : 'w-1 bg-border hover:bg-primary'
              }
            />
            <Panel
              id="application"
              panelRef={applicationPanel}
              collapsible
              defaultSize="28%"
              minSize={stacked ? '380px' : compact ? 0 : '24%'}
              className="h-full min-w-0"
            >
              {application}
            </Panel>
          </>
        )}
        <Separator
          aria-label={t('pblV3.ide.resize')}
          className={compact ? 'h-1 bg-border hover:bg-primary' : 'w-1 bg-border hover:bg-primary'}
        />
        <Panel
          id="assistant"
          panelRef={assistantPanel}
          collapsible
          defaultSize={application ? '32.4%' : '45%'}
          minSize={stacked ? '400px' : compact ? 0 : hasApplication ? '25%' : '28%'}
          className="h-full min-w-0"
        >
          {assistant}
        </Panel>
      </Group>
    </div>
  );
}
