export interface AncestorPressureRow {
  path: string;
  memoryCurrent: string;
  memoryHigh: string;
  memoryMax: string;
  memoryEventsLocal: string;
}

export function compareAncestorPressure(
  previous: AncestorPressureRow[],
  current: AncestorPressureRow[],
): {
  ancestors: AncestorPressureRow[];
  triggers: Array<{ path: string; event: string; before: string; after: string }>;
};

export function createAncestorPressureMonitor(dependencies?: {
  membership?: string;
  readFile?: (path: string, encoding: 'utf8') => string;
}): {
  taskSlice: string;
  paths: string[];
  check(): boolean;
  failure(): { reason: string; details: unknown } | undefined;
  start(onFailure: (failure: { reason: string; details: unknown }) => void): void;
  stop(): void;
};
