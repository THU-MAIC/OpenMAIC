import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import {
  STANDALONE_FALLBACK_CLASS,
  STANDALONE_ROOT_ELEMENT_ID,
} from '@/lib/export/standalone-html/contract';
import { App } from './App';
import { readPlayerData } from './read-data';

/**
 * The static message the file ships for viewers that do not run scripts. It
 * sits just before the player script, so it is only ever seen when the player
 * did not start. It is hidden as soon as the player script runs and removed
 * after the player's first commit (rendering is asynchronous, so a render
 * error must still find it). If the player fails
 * to start, the message switches to a generic "couldn't start" wording (JavaScript
 * is evidently running).
 */
function removeFallback(doc: Document): void {
  doc.querySelectorAll(`.${STANDALONE_FALLBACK_CLASS}`).forEach((el) => el.remove());
}

/**
 * Hides the message as soon as the player script runs (it stays in the DOM so a
 * failure can bring it back). Scripts that never run leave it untouched.
 */
function hideFallback(doc: Document): void {
  doc.querySelectorAll(`.${STANDALONE_FALLBACK_CLASS}`).forEach((el) => {
    el.setAttribute('hidden', '');
  });
}

function showStartFailure(doc: Document): void {
  doc.querySelectorAll(`.${STANDALONE_FALLBACK_CLASS}`).forEach((el) => {
    el.removeAttribute('hidden');
    const text = el.getAttribute('data-failed-text');
    if (text) el.textContent = text;
    el.setAttribute('data-failed', 'true');
  });
}

/** Removes the fallback once the player has rendered (committed) for the first time. */
function Mounted({ doc, children }: { doc: Document; children: React.ReactNode }) {
  useEffect(() => removeFallback(doc), [doc]);
  return children;
}

/** Mount the player into the document's root element, if present. */
export function mountPlayer(doc: Document): void {
  const root = doc.getElementById(STANDALONE_ROOT_ELEMENT_ID);
  if (!root) return;
  hideFallback(doc);
  try {
    const data = readPlayerData(doc);
    createRoot(root, {
      onUncaughtError: (error) => {
        console.error(error);
        showStartFailure(doc);
      },
    }).render(
      <Mounted doc={doc}>
        <App data={data} />
      </Mounted>,
    );
  } catch (error) {
    console.error(error);
    showStartFailure(doc);
  }
}
