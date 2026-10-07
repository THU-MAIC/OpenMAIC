/**
 * Whether the workspace shows a course read-only.
 *
 * Ownership comes from the course list: a course saved from Discover carries
 * `isOwner === false`. Who produced the document says nothing about it: since
 * generation runs on the server, every generated course records a server
 * producer, and the requesting owner still owns and edits it. A course its
 * generation run is still producing is read-only until the run completes.
 */
export function isCourseReadOnly(input: {
  isOwner: boolean | undefined;
  generating: boolean;
}): boolean {
  return input.isOwner === false || input.generating;
}
