'use client';

import { useState, type ReactNode } from 'react';
import type { PPTElement } from '@openmaic/dsl';
import type { Selection } from '@openmaic/editor/react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import type { SlideContent } from '@/lib/types/stage';
import type { RendererCanvasCommands } from './renderer-canvas-commands';

type RendererContextMenuState =
  | { kind: 'canvas' }
  | { kind: 'locked'; targetId: string }
  | { kind: 'element'; targetId: string; groupAction?: 'group' | 'ungroup' };

function groupMembers(elements: readonly PPTElement[], target: PPTElement): PPTElement[] {
  return target.groupId
    ? elements.filter((element) => element.groupId === target.groupId)
    : [target];
}

export function resolveRendererContextSelection(
  content: SlideContent,
  selection: Selection,
  targetId: string | null,
): Selection | null {
  if (!targetId) return null;
  const target = content.canvas.elements.find((element) => element.id === targetId);
  if (!target || target.lock) return null;
  const ids = groupMembers(content.canvas.elements, target).map((element) => element.id);
  if (
    selection.elementIds.includes(targetId) &&
    ids.every((id) => selection.elementIds.includes(id))
  ) {
    return null;
  }
  return { elementIds: ids, primaryId: target.id };
}

export function getRendererContextMenuState(
  content: SlideContent,
  selection: Selection,
  targetId: string | null,
): RendererContextMenuState {
  if (!targetId) return { kind: 'canvas' };
  const target = content.canvas.elements.find((element) => element.id === targetId);
  if (!target) return { kind: 'canvas' };
  if (target.lock) return { kind: 'locked', targetId };

  const selected = content.canvas.elements.filter((element) =>
    selection.elementIds.includes(element.id),
  );
  if (selected.length < 2) return { kind: 'element', targetId };
  const groupId = selected[0].groupId;
  const sameGroup = Boolean(groupId) && selected.every((element) => element.groupId === groupId);
  return { kind: 'element', targetId, groupAction: sameGroup ? 'ungroup' : 'group' };
}

interface RendererCanvasContextMenuProps {
  children?: ReactNode;
  content: SlideContent;
  selection: Selection;
  commands: RendererCanvasCommands;
  onSelectionChange: (selection: Selection) => void;
}

export function RendererCanvasContextMenu({
  children,
  content,
  selection,
  commands,
  onSelectionChange,
}: RendererCanvasContextMenuProps) {
  const [targetId, setTargetId] = useState<string | null>(null);
  const menu = getRendererContextMenuState(content, selection, targetId);

  const handleContextMenuCapture = (event: React.MouseEvent) => {
    const target = event.target as Element;
    const host = target.closest?.('[data-element-id], [data-context-element-id]');
    const nextTargetId =
      host?.getAttribute('data-element-id') ||
      host?.getAttribute('data-context-element-id') ||
      null;
    setTargetId(nextTargetId);
    const nextSelection = resolveRendererContextSelection(content, selection, nextTargetId);
    if (nextSelection) onSelectionChange(nextSelection);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-renderer-canvas-context-menu=""
          onContextMenuCapture={handleContextMenuCapture}
          className="h-full w-full"
        >
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {menu.kind === 'canvas' && (
          <>
            <ContextMenuItem data-command="paste" onSelect={() => void commands.pasteElements()}>
              粘贴
              <ContextMenuShortcut>Ctrl + V</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem data-command="select-all" onSelect={commands.selectAll}>
              全选
              <ContextMenuShortcut>Ctrl + A</ContextMenuShortcut>
            </ContextMenuItem>
          </>
        )}

        {menu.kind === 'locked' && (
          <ContextMenuItem
            data-command="unlock"
            onSelect={() => commands.unlockTarget(menu.targetId)}
          >
            解锁
          </ContextMenuItem>
        )}

        {menu.kind === 'element' && (
          <>
            <ContextMenuSub>
              <ContextMenuSubTrigger>水平对齐</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                <ContextMenuItem onSelect={() => commands.alignSelection('center')}>
                  水平居中
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => commands.alignSelection('left')}>
                  左对齐
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => commands.alignSelection('right')}>
                  右对齐
                </ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuSub>
              <ContextMenuSubTrigger>垂直对齐</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                <ContextMenuItem onSelect={() => commands.alignSelection('middle')}>
                  垂直居中
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => commands.alignSelection('top')}>
                  顶部对齐
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => commands.alignSelection('bottom')}>
                  底部对齐
                </ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuSeparator />
            <ContextMenuSub>
              <ContextMenuSubTrigger>置于顶层</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                <ContextMenuItem onSelect={() => commands.reorderTarget(menu.targetId, 'front')}>
                  置于顶层
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => commands.reorderTarget(menu.targetId, 'forward')}>
                  上移一层
                </ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuSub>
              <ContextMenuSubTrigger>置于底层</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                <ContextMenuItem onSelect={() => commands.reorderTarget(menu.targetId, 'back')}>
                  置于底层
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => commands.reorderTarget(menu.targetId, 'backward')}>
                  下移一层
                </ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuSeparator />
            <ContextMenuItem data-command="copy" onSelect={() => void commands.copySelection()}>
              复制
              <ContextMenuShortcut>Ctrl + C</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem data-command="cut" onSelect={() => void commands.cutSelection()}>
              剪切
              <ContextMenuShortcut>Ctrl + X</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem data-command="paste" onSelect={() => void commands.pasteElements()}>
              粘贴
              <ContextMenuShortcut>Ctrl + V</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuSeparator />
            {menu.groupAction && (
              <ContextMenuItem data-command="toggle-group" onSelect={commands.toggleGroup}>
                {menu.groupAction === 'ungroup' ? '取消组合' : '组合'}
                <ContextMenuShortcut>Ctrl + G</ContextMenuShortcut>
              </ContextMenuItem>
            )}
            <ContextMenuItem data-command="select-all" onSelect={commands.selectAll}>
              全选
              <ContextMenuShortcut>Ctrl + A</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem data-command="lock" onSelect={commands.lockSelection}>
              锁定
              <ContextMenuShortcut>Ctrl + L</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem
              data-command="delete"
              variant="destructive"
              onSelect={commands.deleteSelection}
            >
              删除
              <ContextMenuShortcut>Delete</ContextMenuShortcut>
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
