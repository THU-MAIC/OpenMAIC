/**
 * Entry of the standalone player bundle. Built by
 * `scripts/build-standalone-player.mjs` into `public/vendor/standalone-player/`
 * and inlined into every standalone HTML export; never imported by the app.
 */
import { mountPlayer } from './mount';

mountPlayer(document);
