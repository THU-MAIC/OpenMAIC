/**
 * Entry of the standalone player bundle. Built by
 * `scripts/build-standalone-player.mjs` into `public/vendor/standalone-player/`
 * and inlined into every standalone HTML export; never imported by the app.
 */
import { createRoot } from 'react-dom/client';
import { STANDALONE_ROOT_ELEMENT_ID } from '@/lib/export/standalone-html/contract';
import { App } from './App';
import { readPlayerData } from './read-data';

const root = document.getElementById(STANDALONE_ROOT_ELEMENT_ID);
if (root) {
  createRoot(root).render(<App data={readPlayerData(document)} />);
}
