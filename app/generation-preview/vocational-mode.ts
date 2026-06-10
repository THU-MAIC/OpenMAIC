export function resolveTaskEngineModeFromOutlineDoneEvent(event: {
  taskEngineMode?: unknown;
  effectiveTaskEngineMode?: unknown;
}): boolean {
  return event.taskEngineMode === true || event.effectiveTaskEngineMode === true;
}
