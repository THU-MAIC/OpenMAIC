/**
 * Gates the editor's two scene-creation entry points — the inter-thumb "+"
 * insertion zones and the per-slide Duplicate menu item.
 *
 * Enabled now that the editor can author a scene's playback `actions`:
 * duplicated slides carry the source's actions (playable as-is), and a blank
 * inserted slide starts with no actions (createBlankSlideScene) — the engine
 * dwells on it so it stays playable while the user fills in the narration via
 * the script timeline / MAIC Agent. Reorder / delete / rename were always
 * playback-safe.
 */
export const SCENE_CREATION_ENABLED = true;
