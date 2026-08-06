export const EDITING_UI_STYLES = `
.maic-editing-ui-root {
  box-sizing: border-box;
  color: var(--maic-editing-ui-fg, #27272a);
  font-family: inherit;
  letter-spacing: 0;
}

.maic-editing-ui-root *,
.maic-editing-ui-root *::before,
.maic-editing-ui-root *::after {
  box-sizing: inherit;
}

.maic-editing-ui-text-toolbar,
.maic-editing-ui-line-toolbar {
  align-items: center;
  background: var(--maic-editing-ui-bg, #ffffff);
  border: 1px solid var(--maic-editing-ui-border, #e4e4e7);
  border-radius: var(--maic-editing-ui-radius, 6px);
  box-shadow: var(
    --maic-editing-ui-shadow,
    0 4px 6px -1px rgb(0 0 0 / 10%), 0 2px 4px -2px rgb(0 0 0 / 10%)
  );
  display: flex;
  flex-wrap: nowrap;
  gap: 4px;
  max-width: calc(100vw - 24px);
  overflow-x: auto;
  padding: 4px;
  position: relative;
  width: max-content;
  z-index: var(--maic-editing-ui-z-index, 80);
}

.maic-editing-ui-insert-toolbar {
  left: 12px;
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  z-index: var(--maic-editing-ui-z-index, 80);
}

.maic-editing-ui-insert-buttons {
  align-items: center;
  background: var(--maic-editing-ui-bg, #ffffff);
  border: 1px solid var(--maic-editing-ui-border, #e4e4e7);
  border-radius: var(--maic-editing-ui-radius, 6px);
  box-shadow: var(
    --maic-editing-ui-shadow,
    0 4px 6px -1px rgb(0 0 0 / 10%), 0 2px 4px -2px rgb(0 0 0 / 10%)
  );
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px;
}

.maic-editing-ui-insert-button {
  flex-basis: 32px;
}

.maic-editing-ui-insert-popover {
  background: var(--maic-editing-ui-bg, #ffffff);
  border: 1px solid var(--maic-editing-ui-border, #e4e4e7);
  border-radius: var(--maic-editing-ui-radius, 6px);
  box-shadow: var(
    --maic-editing-ui-shadow,
    0 4px 6px -1px rgb(0 0 0 / 10%), 0 2px 4px -2px rgb(0 0 0 / 10%)
  );
  left: 44px;
  min-width: 160px;
  padding: 12px;
  position: absolute;
  top: 0;
}

.maic-editing-ui-table-picker {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.maic-editing-ui-table-grid {
  display: grid;
  gap: 4px;
  grid-template-columns: repeat(8, 18px);
}

.maic-editing-ui-table-grid-cell {
  aspect-ratio: 1;
  background: #ffffff;
  border: 1px solid #d4d4d8;
  border-radius: 2px;
  cursor: pointer;
  padding: 0;
}

.maic-editing-ui-table-grid-cell:hover,
.maic-editing-ui-table-grid-cell:focus-visible,
.maic-editing-ui-table-grid-cell[data-active] {
  background: var(--maic-editing-ui-active-bg, #ede9fe);
  border-color: var(--maic-editing-ui-active-fg, #6d28d9);
}

.maic-editing-ui-table-dimensions {
  color: #52525b;
  font-size: 12px;
  font-weight: 500;
  text-align: center;
}

.maic-editing-ui-chart-picker {
  align-items: center;
  display: flex;
  flex-direction: row;
  gap: 4px;
  width: fit-content;
}

.maic-editing-ui-chart-picker-option {
  align-items: center;
  background: #ffffff;
  border: 1px solid #d4d4d8;
  border-radius: 4px;
  color: #3f3f46;
  cursor: pointer;
  display: inline-flex;
  height: 32px;
  justify-content: center;
  padding: 0;
  position: relative;
  width: 32px;
}

.maic-editing-ui-chart-picker-option svg {
  height: 16px;
  width: 16px;
}

.maic-editing-ui-chart-picker-option::after {
  background: #27272a;
  border-radius: 4px;
  color: #ffffff;
  content: attr(data-tooltip);
  font-size: 12px;
  left: 50%;
  opacity: 0;
  padding: 4px 6px;
  pointer-events: none;
  position: absolute;
  top: calc(100% + 6px);
  transform: translateX(-50%);
  transition: opacity 120ms ease;
  white-space: nowrap;
  z-index: 1;
}

.maic-editing-ui-chart-picker-option:hover,
.maic-editing-ui-chart-picker-option:focus-visible {
  background: var(--maic-editing-ui-active-bg, #ede9fe);
  border-color: var(--maic-editing-ui-active-fg, #6d28d9);
  color: var(--maic-editing-ui-active-fg, #6d28d9);
  outline: none;
}

.maic-editing-ui-chart-picker-option:hover::after,
.maic-editing-ui-chart-picker-option:focus-visible::after {
  opacity: 1;
}

.maic-editing-ui-group {
  align-items: center;
  display: flex;
  flex: 0 0 auto;
  gap: 2px;
}

.maic-editing-ui-divider {
  background: var(--maic-editing-ui-border, #e4e4e7);
  flex: 0 0 1px;
  height: 20px;
  width: 1px;
}

.maic-editing-ui-icon-button {
  align-items: center;
  background: transparent;
  border: 0;
  border-radius: 6px;
  color: #52525b;
  cursor: pointer;
  display: inline-flex;
  flex: 0 0 32px;
  height: 32px;
  justify-content: center;
  padding: 0;
  width: 32px;
}

.maic-editing-ui-icon-button svg {
  height: 16px;
  width: 16px;
}

.maic-editing-ui-icon-button:hover {
  background: #f4f4f5;
  color: #18181b;
}

.maic-editing-ui-icon-button[aria-pressed='true'] {
  background: var(--maic-editing-ui-active-bg, #ede9fe);
  color: var(--maic-editing-ui-active-fg, #6d28d9);
}

.maic-editing-ui-icon-button:focus-visible,
.maic-editing-ui-select:focus-visible,
.maic-editing-ui-font-size-input:focus-visible {
  outline: 2px solid var(--maic-editing-ui-active-fg, #6d28d9);
  outline-offset: 1px;
}

.maic-editing-ui-select,
.maic-editing-ui-font-size-input {
  background: var(--maic-editing-ui-bg, #ffffff);
  border: 0;
  border-radius: 6px;
  color: var(--maic-editing-ui-fg, #27272a);
  font: inherit;
  height: 32px;
  letter-spacing: 0;
}

.maic-editing-ui-select {
  font-size: 12px;
  font-weight: 400;
  max-width: 128px;
  min-width: 128px;
  padding: 0 6px;
}

.maic-editing-ui-line-select {
  min-width: 92px;
}

.maic-editing-ui-line-width-select {
  min-width: 60px;
  text-align: center;
}

.maic-editing-ui-line-marker-select {
  min-width: 72px;
}

.maic-editing-ui-font-size-stepper {
  align-items: center;
  background: #f4f4f5;
  border-radius: 6px;
  display: flex;
  height: 32px;
  padding: 2px;
}

.maic-editing-ui-step-button {
  align-items: center;
  background: transparent;
  border: 0;
  border-radius: 4px;
  color: #52525b;
  cursor: pointer;
  display: inline-flex;
  flex: 0 0 28px;
  height: 28px;
  justify-content: center;
  padding: 0;
  width: 28px;
}

.maic-editing-ui-step-button:hover {
  background: #ffffff;
  box-shadow: 0 1px 2px rgb(0 0 0 / 8%);
  color: #18181b;
}

.maic-editing-ui-step-button svg {
  height: 14px;
  width: 14px;
}

.maic-editing-ui-font-size-input {
  font-size: 12px;
  font-weight: 600;
  height: 28px;
  text-align: center;
  width: 36px;
}

.maic-editing-ui-color-control {
  flex: 0 0 auto;
  position: relative;
}

.maic-editing-ui-color-button-preview,
.maic-editing-ui-color-picker-preview span {
  border: 1px solid var(--maic-editing-ui-border, #e4e4e7);
  border-radius: 3px;
  display: block;
  height: 16px;
  width: 16px;
}

.maic-editing-ui-delete-button:hover {
  background: #fff1f2;
  color: #e11d48;
}

.maic-editing-ui-delete-button {
  color: #71717a;
}

.maic-editing-ui-color-popover {
  background: var(--maic-editing-ui-bg, #ffffff);
  border: 1px solid var(--maic-editing-ui-border, #e4e4e7);
  border-radius: var(--maic-editing-ui-radius, 6px);
  box-shadow: var(
    --maic-editing-ui-shadow,
    0 4px 6px -1px rgb(0 0 0 / 10%), 0 2px 4px -2px rgb(0 0 0 / 10%)
  );
  box-sizing: border-box;
  padding: 12px;
  width: 248px;
}

.maic-editing-ui-color-popover-overlay {
  left: 0;
  position: fixed;
  top: 0;
  z-index: calc(var(--maic-editing-ui-z-index, 80) + 1);
}

.maic-editing-ui-color-picker {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 224px;
}

.maic-editing-ui-color-picker .react-colorful {
  height: auto;
  width: 100%;
}

.maic-editing-ui-color-picker .react-colorful__saturation {
  border-bottom: 0;
  border-radius: 6px;
  height: 128px;
}

.maic-editing-ui-color-picker .react-colorful__hue {
  border-radius: 999px;
  height: 10px;
  margin-top: 10px;
}

.maic-editing-ui-color-picker .react-colorful__pointer {
  border-width: 2px;
  height: 14px;
  width: 14px;
}

.maic-editing-ui-color-current-row {
  align-items: center;
  display: flex;
  gap: 8px;
  justify-content: space-between;
}

.maic-editing-ui-color-current-value {
  align-items: center;
  display: flex;
  flex: 1 1 auto;
  gap: 8px;
  min-width: 0;
}

.maic-editing-ui-color-current-swatch {
  border-radius: 4px;
  box-shadow: inset 0 0 0 1px rgb(0 0 0 / 15%);
  flex: 0 0 20px;
  height: 20px;
  width: 20px;
}

.maic-editing-ui-color-current-hex {
  color: #71717a;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
  letter-spacing: 0.05em;
  overflow: hidden;
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}

.maic-editing-ui-color-eyedropper {
  align-items: center;
  background: transparent;
  border: 0;
  border-radius: 6px;
  color: #71717a;
  cursor: pointer;
  display: inline-flex;
  flex: 0 0 28px;
  height: 28px;
  justify-content: center;
  padding: 0;
  width: 28px;
}

.maic-editing-ui-color-eyedropper:hover {
  background: #f4f4f5;
  color: #3f3f46;
}

.maic-editing-ui-color-eyedropper svg {
  height: 14px;
  width: 14px;
}

.maic-editing-ui-color-swatches {
  border-top: 1px solid #f4f4f5;
  display: flex;
  gap: 4px;
  padding-top: 12px;
}

.maic-editing-ui-color-swatch {
  border: 0;
  border-radius: 4px;
  box-shadow: inset 0 0 0 1px rgb(0 0 0 / 10%);
  cursor: pointer;
  flex: 0 0 18px;
  height: 18px;
  padding: 0;
  transition: transform 150ms ease;
  width: 18px;
}

.maic-editing-ui-color-swatch:hover {
  transform: scale(1.1);
}

.maic-editing-ui-color-swatch:focus-visible,
.maic-editing-ui-color-eyedropper:focus-visible {
  outline: 2px solid var(--maic-editing-ui-active-fg, #6d28d9);
  outline-offset: 1px;
}
`;
