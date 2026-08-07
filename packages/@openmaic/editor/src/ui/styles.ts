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
.maic-editing-ui-line-toolbar,
.maic-editing-ui-element-toolbar {
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
  overflow-y: hidden;
  padding: 4px;
  position: relative;
  width: max-content;
  z-index: var(--maic-editing-ui-z-index, 80);
}

.maic-editing-ui-image-picker-popover {
  background: var(--maic-editing-ui-bg, #ffffff);
  border: 1px solid var(--maic-editing-ui-border, #e4e4e7);
  border-radius: var(--maic-editing-ui-radius, 6px);
  box-shadow: var(
    --maic-editing-ui-shadow,
    0 4px 6px -1px rgb(0 0 0 / 10%), 0 2px 4px -2px rgb(0 0 0 / 10%)
  );
  left: 0;
  min-width: 288px;
  padding: 12px;
  position: absolute;
  top: calc(100% + 8px);
}

.maic-editing-ui-context-menu-root {
  height: 100%;
  width: 100%;
}

.maic-editing-ui-context-menu,
.maic-editing-ui-context-menu-submenu-content {
  background: var(--maic-editing-ui-bg, #ffffff);
  border: 1px solid var(--maic-editing-ui-border, #e4e4e7);
  border-radius: var(--maic-editing-ui-radius, 6px);
  box-shadow: var(
    --maic-editing-ui-shadow,
    0 10px 15px -3px rgb(0 0 0 / 12%), 0 4px 6px -4px rgb(0 0 0 / 12%)
  );
  min-width: 180px;
  padding: 4px;
}

.maic-editing-ui-context-menu-item {
  align-items: center;
  background: transparent;
  border: 0;
  border-radius: 4px;
  color: #3f3f46;
  cursor: pointer;
  display: flex;
  font: inherit;
  font-size: 13px;
  justify-content: space-between;
  line-height: 20px;
  min-height: 28px;
  padding: 4px 8px;
  text-align: left;
  width: 100%;
}

.maic-editing-ui-context-menu-item:hover,
.maic-editing-ui-context-menu-item:focus-visible {
  background: var(--maic-editing-ui-active-bg, #ede9fe);
  color: var(--maic-editing-ui-active-fg, #6d28d9);
  outline: none;
}

.maic-editing-ui-context-menu-item.is-destructive {
  color: #dc2626;
}

.maic-editing-ui-context-menu-shortcut {
  color: #a1a1aa;
  font-size: 11px;
  margin-left: 20px;
}

.maic-editing-ui-context-menu-separator {
  background: var(--maic-editing-ui-border, #e4e4e7);
  height: 1px;
  margin: 4px;
}

.maic-editing-ui-context-menu-submenu {
  position: relative;
}

.maic-editing-ui-context-menu-submenu-content {
  display: none;
  left: calc(100% + 4px);
  position: absolute;
  top: -4px;
  z-index: 1;
}

.maic-editing-ui-context-menu-submenu:hover .maic-editing-ui-context-menu-submenu-content,
.maic-editing-ui-context-menu-submenu:focus-within .maic-editing-ui-context-menu-submenu-content {
  display: block;
}

.maic-editing-ui-insert-toolbar {
  --maic-editing-ui-insert-rail-size: 48px;
  position: absolute;
  z-index: var(--maic-editing-ui-z-index, 80);
}

.maic-editing-ui-insert-toolbar[data-placement='left'] {
  left: 0;
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
}

.maic-editing-ui-insert-toolbar[data-placement='top'] {
  left: 50%;
  top: 0;
  transform: translateX(-50%);
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

.maic-editing-ui-insert-toolbar[data-placement='top'] .maic-editing-ui-insert-buttons {
  flex-direction: row;
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

.maic-editing-ui-insert-toolbar[data-placement='top'] .maic-editing-ui-insert-popover {
  left: 0;
  top: 44px;
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

.maic-editing-ui-line-insert-picker {
  display: grid;
  gap: 4px;
  grid-template-columns: repeat(5, 32px);
}

.maic-editing-ui-line-insert-option {
  align-items: center;
  background: #ffffff;
  border: 1px solid transparent;
  border-radius: 4px;
  color: #52525b;
  cursor: pointer;
  display: inline-flex;
  height: 32px;
  justify-content: center;
  padding: 5px;
  width: 32px;
}

.maic-editing-ui-line-insert-option:hover,
.maic-editing-ui-line-insert-option:focus-visible {
  background: var(--maic-editing-ui-active-bg, #ede9fe);
  border-color: var(--maic-editing-ui-active-fg, #6d28d9);
  color: var(--maic-editing-ui-active-fg, #6d28d9);
  outline: none;
}

.maic-editing-ui-line-insert-option svg {
  height: 22px;
  width: 22px;
}

.maic-editing-ui-background-picker {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 264px;
}

.maic-editing-ui-background-tabs {
  display: grid;
  grid-template-columns: 1fr 1fr;
}

.maic-editing-ui-background-tab {
  background: #ffffff;
  border: 1px solid var(--maic-editing-ui-border, #e4e4e7);
  color: #52525b;
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  min-height: 32px;
}

.maic-editing-ui-background-tab:first-child {
  border-radius: 4px 0 0 4px;
}

.maic-editing-ui-background-tab:last-child {
  border-left: 0;
  border-radius: 0 4px 4px 0;
}

.maic-editing-ui-background-tab[data-active] {
  background: var(--maic-editing-ui-active-bg, #ede9fe);
  color: var(--maic-editing-ui-active-fg, #6d28d9);
}

.maic-editing-ui-background-color-field {
  color: #52525b;
  display: flex;
  flex-direction: column;
  font-size: 12px;
  gap: 6px;
}

.maic-editing-ui-background-color-inputs {
  align-items: center;
  border: 1px solid var(--maic-editing-ui-border, #e4e4e7);
  border-radius: 4px;
  display: flex;
  gap: 8px;
  padding: 4px;
}

.maic-editing-ui-background-color-inputs input[type='color'] {
  appearance: none;
  background: transparent;
  border: 0;
  cursor: pointer;
  height: 28px;
  padding: 0;
  width: 32px;
}

.maic-editing-ui-background-color-inputs input[type='text'] {
  border: 0;
  color: #3f3f46;
  font: inherit;
  min-width: 0;
  outline: 0;
  width: 100%;
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

.maic-editing-ui-tooltip-button {
  position: relative;
}

.maic-editing-ui-tooltip-button::after {
  background: #27272a;
  border-radius: 4px;
  color: #ffffff;
  content: attr(data-tooltip);
  font-size: 12px;
  line-height: 16px;
  opacity: 0;
  padding: 4px 6px;
  pointer-events: none;
  position: absolute;
  transition: opacity 120ms ease;
  white-space: nowrap;
  z-index: 2;
}

.maic-editing-ui-tooltip-button[data-tooltip-placement='right']::after {
  left: calc(100% + 6px);
  top: 50%;
  transform: translateY(-50%);
}

.maic-editing-ui-tooltip-button[data-tooltip-placement='bottom']::after {
  left: 50%;
  top: calc(100% + 6px);
  transform: translateX(-50%);
}

.maic-editing-ui-tooltip-button:hover::after,
.maic-editing-ui-tooltip-button:focus-visible::after {
  opacity: 1;
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

.maic-editing-ui-latex-backdrop {
  align-items: center;
  background: rgb(24 24 27 / 42%);
  display: flex;
  inset: 0;
  justify-content: center;
  padding: 24px;
  position: fixed;
  z-index: calc(var(--maic-editing-ui-z-index, 80) + 20);
}

.maic-editing-ui-latex-dialog {
  background: #ffffff;
  border-radius: 8px;
  box-shadow: 0 20px 44px rgb(0 0 0 / 22%);
  color: #27272a;
  max-height: min(680px, calc(100vh - 48px));
  max-width: 720px;
  overflow: hidden;
  width: min(720px, 100%);
}

.maic-editing-ui-latex-main {
  display: grid;
  gap: 20px;
  grid-template-columns: minmax(0, 1fr);
  max-height: calc(min(680px, 100vh - 48px) - 64px);
  overflow: auto;
  padding: 20px;
}

.maic-editing-ui-latex-workspace {
  display: grid;
  grid-template-rows: auto minmax(160px, 1fr) minmax(144px, 0.7fr);
  min-height: 420px;
}

.maic-editing-ui-latex-source-label,
.maic-editing-ui-latex-preview-label {
  color: #52525b;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 6px;
}

.maic-editing-ui-latex-source {
  border: 1px solid #d4d4d8;
  border-radius: 6px;
  color: #18181b;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 13px;
  line-height: 1.5;
  min-height: 0;
  padding: 10px;
  resize: none;
}

.maic-editing-ui-latex-source:focus {
  border-color: var(--maic-editing-ui-active-fg, #6d28d9);
  outline: 2px solid color-mix(in srgb, var(--maic-editing-ui-active-fg, #6d28d9) 20%, transparent);
  outline-offset: 1px;
}

.maic-editing-ui-latex-preview-shell {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  margin-top: 16px;
  min-height: 0;
}

.maic-editing-ui-latex-preview {
  align-items: center;
  background: #fafafa;
  border: 1px solid #e4e4e7;
  border-radius: 6px;
  display: flex;
  justify-content: center;
  min-height: 0;
  overflow: auto;
  padding: 16px;
}

.maic-editing-ui-latex-preview .katex-display,
.maic-editing-ui-latex-symbol-grid .katex-display,
.maic-editing-ui-latex-preset-list .katex-display {
  margin: 0;
}

.maic-editing-ui-latex-error {
  color: #dc2626;
  font-size: 12px;
  line-height: 1.4;
  margin: 6px 0 0;
  min-height: 17px;
}

.maic-editing-ui-latex-palette {
  border: 1px solid #e4e4e7;
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  min-height: 420px;
  overflow: hidden;
}

.maic-editing-ui-latex-tabs,
.maic-editing-ui-latex-symbol-groups {
  background: #fafafa;
  border-bottom: 1px solid #e4e4e7;
  display: flex;
  gap: 2px;
  padding: 6px;
}

.maic-editing-ui-latex-tabs button,
.maic-editing-ui-latex-symbol-groups button {
  background: transparent;
  border: 0;
  border-radius: 4px;
  color: #52525b;
  cursor: pointer;
  font-size: 12px;
  min-height: 28px;
  padding: 0 8px;
}

.maic-editing-ui-latex-tabs button[aria-selected='true'],
.maic-editing-ui-latex-symbol-groups button[aria-selected='true'] {
  background: #ede9fe;
  color: #6d28d9;
}

.maic-editing-ui-latex-symbol-grid {
  display: grid;
  gap: 4px;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  overflow: auto;
  padding: 12px;
}

.maic-editing-ui-latex-symbol-grid button,
.maic-editing-ui-latex-preset-list button {
  align-items: center;
  background: #ffffff;
  border: 1px solid #e4e4e7;
  border-radius: 4px;
  color: #3f3f46;
  cursor: pointer;
  display: flex;
  justify-content: center;
  min-height: 40px;
  padding: 6px;
}

.maic-editing-ui-latex-symbol-grid button:hover,
.maic-editing-ui-latex-preset-list button:hover {
  background: #faf5ff;
  border-color: #a78bfa;
}

.maic-editing-ui-latex-preset-list {
  display: grid;
  gap: 8px;
  overflow: auto;
  padding: 12px;
}

.maic-editing-ui-latex-preset-list button {
  align-items: flex-start;
  flex-direction: column;
  gap: 6px;
  text-align: left;
}

.maic-editing-ui-latex-preset-list button > span:first-child {
  color: #52525b;
  font-size: 11px;
}

.maic-editing-ui-latex-footer {
  border-top: 1px solid #e4e4e7;
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  padding: 12px 20px;
}

.maic-editing-ui-latex-footer button {
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  height: 32px;
  padding: 0 14px;
}

.maic-editing-ui-latex-cancel {
  background: #ffffff;
  border: 1px solid #d4d4d8;
  color: #3f3f46;
}

.maic-editing-ui-latex-confirm {
  background: var(--maic-editing-ui-active-fg, #6d28d9);
  border: 1px solid var(--maic-editing-ui-active-fg, #6d28d9);
  color: #ffffff;
}

.maic-editing-ui-latex-confirm:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.maic-editing-ui-latex-toolbar,
.maic-editing-ui-video-toolbar,
.maic-editing-ui-audio-toolbar {
  align-items: center;
  background: #ffffff;
  border: 1px solid #e4e4e7;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgb(0 0 0 / 14%);
  display: flex;
  padding: 4px;
}

.maic-editing-ui-video-toolbar-root {
  min-width: 0;
}

.maic-editing-ui-video-poster-popover {
  background: var(--maic-editing-ui-bg, #ffffff);
  border: 1px solid var(--maic-editing-ui-border, #e4e4e7);
  border-radius: var(--maic-editing-ui-radius, 6px);
  box-shadow: var(
    --maic-editing-ui-shadow,
    0 4px 6px -1px rgb(0 0 0 / 10%), 0 2px 4px -2px rgb(0 0 0 / 10%)
  );
  left: 0;
  min-width: 288px;
  padding: 12px;
  position: absolute;
  top: calc(100% + 8px);
}

.maic-editing-ui-video-insert-picker {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.maic-editing-ui-audio-insert-picker {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.maic-editing-ui-video-dropzone {
  background: transparent;
  border: 1px dashed #d4d4d8;
  border-radius: 6px;
  color: #71717a;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  min-height: 72px;
  padding: 12px;
  text-align: center;
}

.maic-editing-ui-audio-dropzone {
  background: transparent;
  border: 1px dashed #d4d4d8;
  border-radius: 6px;
  color: #71717a;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  min-height: 72px;
  padding: 12px;
  text-align: center;
}

.maic-editing-ui-video-dropzone:hover,
.maic-editing-ui-video-dropzone:focus-visible {
  border-color: var(--maic-editing-ui-active-fg, #6d28d9);
  color: var(--maic-editing-ui-active-fg, #6d28d9);
  outline: none;
}

.maic-editing-ui-audio-dropzone:hover,
.maic-editing-ui-audio-dropzone:focus-visible {
  border-color: var(--maic-editing-ui-active-fg, #6d28d9);
  color: var(--maic-editing-ui-active-fg, #6d28d9);
  outline: none;
}

.maic-editing-ui-video-or {
  color: #a1a1aa;
  font-size: 12px;
  text-align: center;
}

.maic-editing-ui-audio-or {
  color: #a1a1aa;
  font-size: 12px;
  text-align: center;
}

.maic-editing-ui-video-url-row {
  display: flex;
  gap: 8px;
}

.maic-editing-ui-audio-url-row {
  display: flex;
  gap: 8px;
}

.maic-editing-ui-video-url-row input {
  border: 1px solid #d4d4d8;
  border-radius: 4px;
  font: inherit;
  font-size: 12px;
  min-width: 0;
  padding: 6px 8px;
  width: 100%;
}

.maic-editing-ui-audio-url-row input {
  border: 1px solid #d4d4d8;
  border-radius: 4px;
  font: inherit;
  font-size: 12px;
  min-width: 0;
  padding: 6px 8px;
  width: 100%;
}

.maic-editing-ui-video-url-row button {
  background: var(--maic-editing-ui-active-fg, #6d28d9);
  border: 1px solid var(--maic-editing-ui-active-fg, #6d28d9);
  border-radius: 4px;
  color: #ffffff;
  cursor: pointer;
  flex: 0 0 auto;
  font: inherit;
  font-size: 12px;
  padding: 0 10px;
}

.maic-editing-ui-audio-url-row button {
  background: var(--maic-editing-ui-active-fg, #6d28d9);
  border: 1px solid var(--maic-editing-ui-active-fg, #6d28d9);
  border-radius: 4px;
  color: #ffffff;
  cursor: pointer;
  flex: 0 0 auto;
  font: inherit;
  font-size: 12px;
  padding: 0 10px;
}

.maic-editing-ui-video-url-row button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.maic-editing-ui-audio-url-row button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.maic-editing-ui-visually-hidden {
  height: 1px;
  opacity: 0;
  overflow: hidden;
  pointer-events: none;
  position: absolute;
  width: 1px;
}

@media (max-width: 720px) {
  .maic-editing-ui-latex-backdrop {
    align-items: flex-start;
    padding: 12px;
  }

  .maic-editing-ui-latex-main {
    grid-template-columns: minmax(0, 1fr);
    padding: 16px;
  }

  .maic-editing-ui-latex-workspace {
    min-height: 360px;
  }
}
`;
