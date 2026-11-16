/** A quiz page was handed in and graded. Its renderer lives far from the chrome that cares. */
type Listener = (sceneId: string) => void;
const listeners = new Set<Listener>();

export function emitQuizReviewed(sceneId: string): void {
  for (const listener of listeners) listener(sceneId);
}

export function onQuizReviewed(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
