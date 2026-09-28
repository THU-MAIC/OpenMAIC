/**
 * A user-created folder that groups courses in the library. Folders and course
 * membership are owner-scoped server data, served by the `/api/folders` routes.
 */
export interface FolderRecord {
  id: string;
  name: string;
  /** Sort order (ascending). */
  order: number;
  createdAt: number; // timestamp
  updatedAt: number; // timestamp
}
