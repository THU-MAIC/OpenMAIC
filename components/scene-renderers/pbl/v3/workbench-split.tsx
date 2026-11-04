'use client';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels';
import { useI18n } from '@/lib/hooks/use-i18n';

export function WorkbenchSplit({
  workspace,
  assistant,
  application,
  showApplication = false,
  onCollapseApplication,
  onCollapseWorkspace,
  onCollapseAssistant,
  showWorkspace = true,
  showAssistant = true,
}: {
  workspace: ReactNode;
  assistant: ReactNode;
  application?: ReactNode;
  showApplication?: boolean;
  onCollapseApplication?: () => void;
  onCollapseWorkspace?: () => void;
  onCollapseAssistant?: () => void;
  showWorkspace?: boolean;
  showAssistant?: boolean;
}) {
  const hasApplication = !!application;
  const appVisible = hasApplication && showApplication;
  const workAreaVisible = showWorkspace || appVisible;
  const [compact, setCompact] = useState(false);
  const workAreaPanel = usePanelRef(),
    workspacePanel = usePanelRef(),
    assistantPanel = usePanelRef(),
    applicationPanel = usePanelRef();
  const syncWorkAreaVisibility = useCallback(
    (inPixels: number) => {
      // A zero-sized outer panel cannot retain an inner resize. Reapply visibility
      // when the outer panel regains size without remounting its editor or iframe.
      if (!inPixels) return;
      if (showWorkspace) workspacePanel.current?.expand();
      if (appVisible) applicationPanel.current?.expand();
      if (!showWorkspace) workspacePanel.current?.collapse();
      if (!appVisible) applicationPanel.current?.collapse();
    },
    [showWorkspace, appVisible, workspacePanel, applicationPanel],
  );
  useEffect(() => {
    syncWorkAreaVisibility(workAreaPanel.current?.getSize().inPixels ?? 0);
  }, [compact, syncWorkAreaVisibility, workAreaPanel]);
  useEffect(() => {
    if (showAssistant) assistantPanel.current?.expand();
    else assistantPanel.current?.collapse();
  }, [compact, showAssistant, assistantPanel]);
  // Switching axes can clamp a visible panel to zero under the new constraints.
  useEffect(() => {
    if (workAreaVisible) workAreaPanel.current?.expand();
    else workAreaPanel.current?.collapse();
  }, [compact, workAreaVisible, workAreaPanel]);
  const ref = useRef<HTMLDivElement>(null);
  const { t } = useI18n();
  const visiblePanels = Number(showWorkspace) + Number(showAssistant) + Number(appVisible);
  const stacked = compact && visiblePanels > 1;
  const workAreaHeight = (showWorkspace ? 350 : 0) + (appVisible ? 380 : 0);
  const stackHeight = workAreaHeight + (showAssistant ? 400 : 0) + (visiblePanels - 1) * 4;
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) =>
      setCompact(entry!.contentRect.width < (appVisible ? 1040 : 560)),
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [appVisible]);
  const separator = compact ? 'h-1 bg-border hover:bg-primary' : 'w-1 bg-border hover:bg-primary';
  return (
    <div ref={ref} className="min-h-0 flex-1 overflow-auto" data-testid="pbl-workbench-split">
      <Group
        orientation={compact ? 'vertical' : 'horizontal'}
        style={{ height: stacked ? stackHeight : '100%', minHeight: stacked ? stackHeight : 0 }}
        onLayoutChanged={(layout, meta) => {
          if (!meta.isUserInteraction) return;
          if (layout['work-area'] === 0) {
            if (showWorkspace) onCollapseWorkspace?.();
            if (appVisible) onCollapseApplication?.();
          }
          if (layout.assistant === 0 && showAssistant) onCollapseAssistant?.();
        }}
      >
        {/* The outer divider always borders the visible work area and assistant.
            Keeping the application in its own inner group preserves its iframe. */}
        <Panel
          id="work-area"
          panelRef={workAreaPanel}
          onResize={(size) => syncWorkAreaVisibility(size.inPixels)}
          collapsible
          defaultSize="55%"
          minSize={stacked ? `${workAreaHeight}px` : compact ? 0 : '30%'}
          className="h-full min-w-0"
        >
          <Group
            orientation={compact ? 'vertical' : 'horizontal'}
            onLayoutChanged={(layout, meta) => {
              if (!meta.isUserInteraction) return;
              if (showWorkspace && layout.workspace === 0) onCollapseWorkspace?.();
              if (appVisible && layout.application === 0) onCollapseApplication?.();
            }}
          >
            <Panel
              id="workspace"
              panelRef={workspacePanel}
              collapsible
              defaultSize={hasApplication ? '58.6%' : '100%'}
              minSize={stacked ? '350px' : compact ? 0 : '40%'}
              className="h-full min-w-0"
            >
              {workspace}
            </Panel>
            {application && (
              <>
                <Separator
                  aria-label={t('pblV3.ide.resize')}
                  disabled={!appVisible || !showWorkspace}
                  className={!appVisible || !showWorkspace ? 'hidden' : separator}
                />
                <Panel
                  id="application"
                  panelRef={applicationPanel}
                  collapsible
                  defaultSize="41.4%"
                  minSize={stacked ? '380px' : compact ? 0 : '35%'}
                  className="h-full min-w-0"
                >
                  {application}
                </Panel>
              </>
            )}
          </Group>
        </Panel>
        <Separator
          aria-label={t('pblV3.ide.resize')}
          disabled={!workAreaVisible || !showAssistant}
          className={!workAreaVisible || !showAssistant ? 'hidden' : separator}
        />
        <Panel
          id="assistant"
          panelRef={assistantPanel}
          collapsible
          defaultSize="45%"
          minSize={stacked ? '400px' : compact ? 0 : '28%'}
          className="h-full min-w-0"
        >
          {assistant}
        </Panel>
      </Group>
    </div>
  );
}
