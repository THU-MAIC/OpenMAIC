/**
 * The renderer tidying a slide (removing an empty text box), as opposed to someone
 * editing it. Such a write lands in the document but is not an undo step, even when
 * it happens to fire during a pointer gesture on another element.
 */

let depth = 0;

export function withTidyWrite(write: () => void): void {
  depth += 1;
  try {
    write();
  } finally {
    depth -= 1;
  }
}

export function isTidyWrite(): boolean {
  return depth > 0;
}
