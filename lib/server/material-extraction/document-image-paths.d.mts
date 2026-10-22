export interface ImagePathIndex {
  exact: ReadonlyMap<string, string>;
  byBasename: ReadonlyMap<string, string>;
}
export function isProviderPath(target: string): boolean;
export function normalizePath(target: string): string;
export function basename(path: string): string;
export function keyOf(index: ImagePathIndex, target: string): string | undefined;
