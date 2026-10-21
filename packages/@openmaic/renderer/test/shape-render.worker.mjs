import { parentPort } from 'node:worker_threads';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
// Exercise the shipped SDK in isolation: a synchronous loop must not hang Vitest.
import { BaseShapeElement } from '../dist/elements/shape/BaseShapeElement.js';

parentPort.on('message', (elementInfo) => {
  try {
    parentPort.postMessage({
      html: renderToStaticMarkup(createElement(BaseShapeElement, { elementInfo })),
    });
  } catch (error) {
    parentPort.postMessage({ error: String(error) });
  }
});
parentPort.postMessage({ ready: true });
