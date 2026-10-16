/** Narrow public surface used by the non-executing widget identifier check. */
declare module 'eslint-scope' {
  interface Identifier {
    name: string;
    start: number;
    loc?: { start: { line: number; column: number } };
  }
  interface Reference {
    identifier: Identifier;
    from: { isStrict: boolean };
    isRead(): boolean;
    isWrite(): boolean;
  }
  interface ScopeManager {
    getDeclaredVariables(node: unknown): ReadonlyArray<{
      scope: { type: string; isStrict: boolean };
    }>;
    globalScope: {
      variables: ReadonlyArray<{ name: string }>;
      through: ReadonlyArray<Reference>;
    };
  }
  export function analyze(
    ast: unknown,
    options: {
      ecmaVersion: 2022;
      sourceType: 'script' | 'module';
      nodejsScope: false;
      optimistic: false;
      ignoreEval: false;
      impliedStrict: false;
    },
  ): ScopeManager;
}
