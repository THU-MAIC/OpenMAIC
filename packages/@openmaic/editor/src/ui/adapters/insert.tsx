import { createElement } from 'react';
import { BarChart3, Image as ImageIcon, Minus, PaintBucket, Table2, Type } from 'lucide-react';
import type { ChartType } from '@openmaic/dsl';
import { BackgroundInsertPicker } from '../insert/BackgroundInsertPicker';
import { readImageDimensions } from '../assets/imageDimensions';
import { ChartInsertPicker } from '../insert/ChartInsertPicker';
import { LineInsertPicker, type LineInsertPreset } from '../insert/LineInsertPicker';
import { TableInsertPicker } from '../insert/TableInsertPicker';
import type { InsertToolbarItem } from '../types';
import type { EditorInsertContribution } from './insertRegistry';
import {
  createDefaultChartElement,
  createDefaultImageElement,
  createDefaultTableElement,
} from './defaultElements';
import { renderAssetPicker } from './shared';
import type { ElementAdapterContext } from './types';

export type EditorCreationMode =
  | { readonly type: 'text' }
  | { readonly type: 'line'; readonly preset: LineInsertPreset }
  | null;

export function createHostInsertItems(
  context: ElementAdapterContext,
  mode: EditorCreationMode,
  setMode: (mode: EditorCreationMode) => void,
): readonly EditorInsertContribution[] {
  const labels = context.labels;
  const lineLabels = { label: labels.insert.line, ...labels.insert.linePresets };

  const items: InsertToolbarItem[] = [
    {
      id: 'insert-text',
      label: labels.insert.text,
      tooltip: labels.insert.text,
      icon: createElement(Type, { 'aria-hidden': true }),
      active: mode?.type === 'text',
      onInvoke: () => setMode(mode?.type === 'text' ? null : { type: 'text' }),
    },
    {
      id: 'insert-image',
      label: labels.insert.image,
      tooltip: labels.insert.image,
      icon: createElement(ImageIcon, { 'aria-hidden': true }),
      renderPopover: ({ close }) =>
        renderAssetPicker(context, {
          accept: 'image/*',
          close,
          onPick: async (asset) => {
            const dimensions =
              asset.width && asset.height
                ? { width: asset.width, height: asset.height }
                : await readImageDimensions(asset.src);
            const id = context.host.createElementId('image');
            context.dispatch(
              [
                {
                  type: 'element.add',
                  element: createDefaultImageElement(id, asset.src, dimensions),
                },
              ],
              { origin: 'toolbar' },
            );
            context.select({ elementIds: [id], primaryId: id });
            close();
          },
        }),
    },
    {
      id: 'insert-table',
      label: labels.insert.table,
      tooltip: labels.insert.table,
      icon: createElement(Table2, { 'aria-hidden': true }),
      renderPopover: ({ close }) =>
        createElement(TableInsertPicker, {
          getLabel: labels.insert.tableDimensions,
          onPick: (rows, columns) => {
            const id = context.host.createElementId('table');
            context.dispatch(
              [{ type: 'element.add', element: createDefaultTableElement(id, rows, columns) }],
              { origin: 'toolbar' },
            );
            context.select({ elementIds: [id], primaryId: id });
            close();
          },
        }),
    },
    {
      id: 'insert-chart',
      label: labels.insert.chart,
      tooltip: labels.insert.chart,
      icon: createElement(BarChart3, { 'aria-hidden': true }),
      renderPopover: ({ close }) =>
        createElement(ChartInsertPicker, {
          options: [
            { type: 'bar' as ChartType, label: labels.insert.chartBar },
            { type: 'line' as ChartType, label: labels.insert.chartLine },
            { type: 'pie' as ChartType, label: labels.insert.chartPie },
          ],
          onPick: (chartType: ChartType) => {
            const id = context.host.createElementId('chart');
            context.dispatch(
              [{ type: 'element.add', element: createDefaultChartElement(id, chartType) }],
              { origin: 'toolbar' },
            );
            context.select({ elementIds: [id], primaryId: id });
            close();
          },
        }),
    },
    {
      id: 'insert-line',
      label: labels.insert.line,
      tooltip: labels.insert.line,
      icon: createElement(Minus, { 'aria-hidden': true }),
      active: mode?.type === 'line',
      renderPopover: ({ close }) =>
        createElement(LineInsertPicker, {
          labels: lineLabels,
          onPick: (preset: LineInsertPreset) => {
            setMode(mode?.type === 'line' ? null : { type: 'line', preset });
            close();
          },
        }),
    },
    {
      id: 'slide-background',
      label: labels.background.label,
      tooltip: labels.background.label,
      icon: createElement(PaintBucket, { 'aria-hidden': true }),
      renderPopover: ({ close }) =>
        createElement(BackgroundInsertPicker, {
          background: context.slide.background,
          labels: labels.background,
          renderImagePicker: (onPick: (src: string) => void) =>
            renderAssetPicker(context, {
              accept: 'image/*',
              close,
              onPick: (asset) => {
                onPick(asset.src);
                close();
              },
            }),
          onChange: (background) =>
            context.dispatch([{ type: 'slide.update', props: { background } }], {
              origin: 'toolbar',
            }),
        }),
    },
  ];
  const types = ['text', 'image', 'table', 'chart', 'line', 'background'] as const;
  return items.map((item, index) => ({ type: types[index], item }));
}
