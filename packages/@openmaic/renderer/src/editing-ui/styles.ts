export const EDITING_UI_STYLES = `
.maic-editing-ui-root {
  --maic-editing-ui-bg: #ffffff;
  --maic-editing-ui-fg: #27272a;
  --maic-editing-ui-muted: #71717a;
  --maic-editing-ui-active-bg: #ede9fe;
  --maic-editing-ui-active-fg: #6d28d9;
  --maic-editing-ui-border: #e4e4e7;
  --maic-editing-ui-shadow: 0 8px 24px rgb(0 0 0 / 14%);
  --maic-editing-ui-radius: 8px;
  --maic-editing-ui-z-index: 80;
  box-sizing: border-box;
  color: var(--maic-editing-ui-fg);
  font-family: inherit;
  letter-spacing: 0;
}

.maic-editing-ui-root *,
.maic-editing-ui-root *::before,
.maic-editing-ui-root *::after {
  box-sizing: inherit;
}

.maic-editing-ui-text-toolbar {
  align-items: center;
  background: var(--maic-editing-ui-bg);
  border: 1px solid var(--maic-editing-ui-border);
  border-radius: var(--maic-editing-ui-radius);
  box-shadow: var(--maic-editing-ui-shadow);
  display: flex;
  flex-wrap: nowrap;
  gap: 4px;
  max-width: calc(100vw - 24px);
  overflow-x: auto;
  padding: 4px;
  position: relative;
  width: max-content;
  z-index: var(--maic-editing-ui-z-index);
}

.maic-editing-ui-group {
  align-items: center;
  display: flex;
  flex: 0 0 auto;
  gap: 2px;
}

.maic-editing-ui-group + .maic-editing-ui-group {
  border-left: 1px solid var(--maic-editing-ui-border);
  padding-left: 4px;
}

.maic-editing-ui-icon-button {
  align-items: center;
  background: transparent;
  border: 0;
  border-radius: 4px;
  color: var(--maic-editing-ui-fg);
  cursor: pointer;
  display: inline-flex;
  flex: 0 0 32px;
  height: 32px;
  justify-content: center;
  padding: 0;
  width: 32px;
}

.maic-editing-ui-icon-button:hover {
  background: color-mix(in srgb, var(--maic-editing-ui-border) 50%, transparent);
}

.maic-editing-ui-icon-button[aria-pressed='true'] {
  background: var(--maic-editing-ui-active-bg);
  color: var(--maic-editing-ui-active-fg);
}

.maic-editing-ui-icon-button:focus-visible,
.maic-editing-ui-select:focus-visible,
.maic-editing-ui-font-size-input:focus-visible {
  outline: 2px solid var(--maic-editing-ui-active-fg);
  outline-offset: 1px;
}

.maic-editing-ui-select,
.maic-editing-ui-font-size-input {
  background: var(--maic-editing-ui-bg);
  border: 1px solid var(--maic-editing-ui-border);
  border-radius: 4px;
  color: var(--maic-editing-ui-fg);
  font: inherit;
  height: 32px;
  letter-spacing: 0;
}

.maic-editing-ui-select {
  max-width: 160px;
  min-width: 112px;
  padding: 0 6px;
}

.maic-editing-ui-font-size-input {
  text-align: center;
  width: 44px;
}
`;
