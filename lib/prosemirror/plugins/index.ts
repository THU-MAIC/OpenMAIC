import { keymap } from 'prosemirror-keymap';
import type { Schema } from 'prosemirror-model';
import { history } from 'prosemirror-history';
import { baseKeymap } from 'prosemirror-commands';
import { dropCursor } from 'prosemirror-dropcursor';
import { gapCursor } from 'prosemirror-gapcursor';

import { buildKeymap } from './keymap';
import { buildInputRules } from './inputrules';
import { placeholderPlugin } from './placeholder';

export interface PluginOptions {
  placeholder?: string;
}

export const buildPlugins = (schema: Schema, options?: PluginOptions) => {
  const placeholder = options?.placeholder;

  const plugins = [
    buildInputRules(schema),
    keymap(buildKeymap(schema)),
    keymap(baseKeymap),
    dropCursor(),
    gapCursor(),
    history(),
  ];

  if (placeholder) plugins.push(placeholderPlugin(placeholder));

  return plugins;
};
