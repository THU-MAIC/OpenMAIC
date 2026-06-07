/**
 * Editor-created slide scenes (blank insert + duplicate) ship without
 * playback `actions`, so the playback engine gives them zero dwell and
 * skips straight past them. Until inserted scenes are seeded with default
 * actions, the editor hides its two scene-creation entry points — the
 * inter-thumb "+" insertion zones and the per-slide Duplicate menu item —
 * while keeping reorder / delete / rename, which are playback-safe.
 *
 * Flip to `true` once newly-created scenes are made playable.
 */
export const SCENE_CREATION_ENABLED = false;
