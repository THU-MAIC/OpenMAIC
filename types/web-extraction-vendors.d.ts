/**
 * Minimal ambient types for the HTML→markdown vendors that ship no
 * TypeScript definitions of their own (the same shim the reference product
 * carries). Only the surface the fetch_url extraction path touches is
 * declared; `@mozilla/readability` and `linkedom` ship their own types.
 */
declare module 'turndown' {
  interface TurndownOptions {
    headingStyle?: 'setext' | 'atx';
    codeBlockStyle?: 'indented' | 'fenced';
  }

  type TurndownPlugin = (service: TurndownService) => void;

  export default class TurndownService {
    constructor(options?: TurndownOptions);
    use(plugin: TurndownPlugin | TurndownPlugin[]): this;
    turndown(input: string | Node): string;
  }
}

declare module '@joplin/turndown-plugin-gfm' {
  import type TurndownService from 'turndown';

  export const gfm: (service: TurndownService) => void;
}
