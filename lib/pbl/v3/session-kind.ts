/** Reserved server-created IDs: these sessions belong to a learning instance, not the chat library. */
export function isPBLRoleSession(id: string): boolean {
  return id.startsWith('pbl-role-');
}
