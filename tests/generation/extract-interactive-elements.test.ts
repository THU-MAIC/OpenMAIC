import { describe, expect, test } from 'vitest';

import { extractInteractiveElements } from '@/lib/generation/scene-generator';

describe('extractInteractiveElements', () => {
  test('returns empty string on empty input', () => {
    expect(extractInteractiveElements('')).toBe('');
  });

  test('collects real element ids so widget actions can select from them', () => {
    const html = `
      <main id="game-root">
        <div id="score-val">0</div>
        <button id="reset-btn" aria-label="Reset the game">Reset</button>
        <div id="active-zone" class="pairing-rules dropzone" role="region">...</div>
        <input id="angle-slider" type="range" name="angle" />
      </main>
    `;
    const inventory = extractInteractiveElements(html);

    expect(inventory).toContain('Elements with id:');
    expect(inventory).toContain('#score-val');
    expect(inventory).toContain('#reset-btn');
    expect(inventory).toContain('aria-label="Reset the game"');
    expect(inventory).toContain('#active-zone');
    expect(inventory).toContain('role=region');
    expect(inventory).toContain('#angle-slider');
    expect(inventory).toContain('type=range');
    expect(inventory).toContain('name=angle');

    expect(inventory).toContain('Notable classes:');
    expect(inventory).toContain('.pairing-rules');
    expect(inventory).toContain('.dropzone');
  });

  test('captures procedural-skill data-step-id attributes', () => {
    const html = `
      <li data-step-id="step-1" id="step-1-row">
        <button id="step-1-control">Complete</button>
        <div id="step-1-feedback"></div>
      </li>
      <li data-step-id="step-2" id="step-2-row"></li>
    `;
    const inventory = extractInteractiveElements(html);

    expect(inventory).toContain('#step-1-row');
    expect(inventory).toContain('data-step-id="step-1"');
    expect(inventory).toContain('#step-1-control');
    expect(inventory).toContain('#step-2-row');
    expect(inventory).toContain('data-step-id="step-2"');
  });

  test('ignores contents of <script> and <style>', () => {
    const html = `
      <style>
        #should-not-appear { color: red; }
        .fake-class { color: blue; }
      </style>
      <script id="widget-config" type="application/json">
        { "id": "not-a-real-id" }
      </script>
      <div id="real-id" class="real-class"></div>
    `;
    const inventory = extractInteractiveElements(html);

    expect(inventory).toContain('#real-id');
    expect(inventory).toContain('.real-class');
    expect(inventory).not.toContain('#should-not-appear');
    expect(inventory).not.toContain('.fake-class');
    expect(inventory).not.toContain('not-a-real-id');
    // The <script id="widget-config"> tag itself lives inside the stripped
    // block, so the widget-config id should not leak into the inventory.
    expect(inventory).not.toContain('widget-config');
  });

  test('deduplicates repeated ids and classes', () => {
    const html = `
      <div id="dup" class="card"></div>
      <div id="dup" class="card"></div>
      <div class="card"></div>
    `;
    const inventory = extractInteractiveElements(html);

    const dupMatches = inventory.match(/#dup/g) || [];
    const cardMatches = inventory.match(/\.card\b/g) || [];
    expect(dupMatches.length).toBe(1);
    expect(cardMatches.length).toBe(1);
  });

  test('drops Tailwind/utility classes so semantic classes survive the cap', () => {
    const html = `
      <div id="game" class="flex items-center p-4 rounded-lg bg-white pairing-rules dna-card md:flex-row hover:bg-gray-100"></div>
      <button class="btn-launch p-2 text-white"></button>
    `;
    const inventory = extractInteractiveElements(html);

    // Semantic classes retained
    expect(inventory).toContain('.pairing-rules');
    expect(inventory).toContain('.dna-card');
    expect(inventory).toContain('.btn-launch');
    // Utility / responsive / hover classes dropped
    expect(inventory).not.toContain('.flex ');
    expect(inventory).not.toContain('.items-center');
    expect(inventory).not.toContain('.p-4');
    expect(inventory).not.toContain('.p-2');
    expect(inventory).not.toContain('.rounded-lg');
    expect(inventory).not.toContain('.bg-white');
    expect(inventory).not.toContain('.md:flex-row');
    expect(inventory).not.toContain('.hover:bg-gray-100');
    expect(inventory).not.toContain('.text-white');
  });

  test('captures attributes after a > inside a quoted attribute value', () => {
    const html = '<button id="go" aria-label="go >>" data-action="advance">Go</button>';
    const inventory = extractInteractiveElements(html);
    expect(inventory).toContain('#go');
    expect(inventory).toContain('aria-label="go >>"');
    expect(inventory).toContain('data-action="advance"');
  });

  test('captures unquoted attribute values', () => {
    const html = '<div id=main class=card></div><button id=go type=button>Go</button>';
    const inventory = extractInteractiveElements(html);
    expect(inventory).toContain('#main');
    expect(inventory).toContain('#go');
    expect(inventory).toContain('type=button');
    // Semantic class name preserved
    expect(inventory).toContain('.card');
  });

  test('ignores HTML comments so commented-out markup does not forge inventory', () => {
    const html = `
      <!-- <button id="old-btn" class="ghost">Removed</button> -->
      <button id="real-btn">Real</button>
    `;
    const inventory = extractInteractiveElements(html);
    expect(inventory).toContain('#real-btn');
    expect(inventory).not.toContain('#old-btn');
    expect(inventory).not.toContain('.ghost');
  });

  test('drops content after an unterminated <script open so template ids leak', () => {
    // A truncated generation leaves the <script> unclosed. Anything after it
    // is inside JS template strings and must not be inventoried.
    const html =
      '<button id="visible">Go</button>' +
      '<script>document.getElementById("visible").innerHTML = `<div id="ghost-id">no</div>`;';
    const inventory = extractInteractiveElements(html);
    expect(inventory).toContain('#visible');
    expect(inventory).not.toContain('#ghost-id');
  });

  test('does not forge phantom attributes from within a quoted attribute value', () => {
    // The reviewer's regression: an aria-label that contains substrings
    // resembling other attributes must not lift them into the inventory. A
    // per-attribute regex would fabricate `name=alpha` and `#fake` from the
    // aria-label's contents; the tag-grammar-aware parser must not.
    const html = '<button id="go" aria-label="try name=alpha or id=fake"></button>';
    const inventory = extractInteractiveElements(html);
    expect(inventory).toContain('#go');
    expect(inventory).toContain('aria-label="try name=alpha or id=fake"');
    // The `#go` row must terminate at the closing quote of the aria-label —
    // no ` name=...` segment lifted out of the label body.
    const goLine = inventory.split('\n').find((line) => line.startsWith('#go')) || '';
    expect(goLine).toMatch(/aria-label="[^"]*"$/);
    // And a phantom `#fake` id row must never appear.
    expect(inventory.split('\n')).not.toContain('#fake <button>');
  });

  test('collapses whitespace in attribute values and caps their length', () => {
    const longLabel = 'a'.repeat(500);
    const html =
      '<button id="one" aria-label="line one\n  line two   line three"></button>' +
      `<button id="two" aria-label="${longLabel}"></button>`;
    const inventory = extractInteractiveElements(html);
    // Multiline / repeated-space label is collapsed to a single line so it
    // cannot forge extra inventory rows or fake prompt sections.
    expect(inventory).toContain('aria-label="line one line two line three"');
    // Long value is truncated so a hostile label cannot swallow the prompt.
    const twoLine = inventory.split('\n').find((line) => line.includes('#two')) || '';
    expect(twoLine.length).toBeLessThan(longLabel.length);
    expect(twoLine).toContain('…');
  });

  test('keeps semantic classes that collide with utility prefixes when declared in <style>', () => {
    // `.grid-cell`, `.fill-blank`, `.text-input`, `.select-btn`, `.ring-carbon`,
    // etc. all look like Tailwind utilities by prefix but are the widget
    // author's own hooks. When declared in the page's <style> block they must
    // survive the utility filter.
    const html = `
      <style>
        .grid-cell { padding: 4px; }
        .fill-blank { border: 1px solid; }
        .text-input:focus { outline: none; }
        .select-btn { cursor: pointer; }
        .ring-carbon { stroke: black; }
      </style>
      <div class="grid-cell fill-blank">
        <input class="text-input" />
        <button class="select-btn">Pick</button>
        <span class="ring-carbon"></span>
      </div>
    `;
    const inventory = extractInteractiveElements(html);
    expect(inventory).toContain('.grid-cell');
    expect(inventory).toContain('.fill-blank');
    expect(inventory).toContain('.text-input');
    expect(inventory).toContain('.select-btn');
    expect(inventory).toContain('.ring-carbon');
  });

  test('surfaces id-less elements via a Stable data attributes section', () => {
    // The interactive-actions system prompt tells the model to target
    // `[data-step-id="step-1"]` for procedural-skill widgets whose step rows
    // typically have no id. Those elements must appear in the inventory or
    // the "prefer inventory" rule silently sends the model back to convention
    // guessing on exactly the widget family the conventions already served.
    const html = `
      <ol>
        <li data-step-id="step-1">Inspect the device</li>
        <li data-step-id="step-2">Confirm the reading</li>
      </ol>
      <button data-action="check">Check</button>
      <button id="reset-btn" data-action="reset">Reset</button>
    `;
    const inventory = extractInteractiveElements(html);

    // id-less rows land in the new section.
    expect(inventory).toContain('Stable data attributes:');
    expect(inventory).toContain('[data-step-id="step-1"] <li>');
    expect(inventory).toContain('[data-step-id="step-2"] <li>');
    expect(inventory).toContain('[data-action="check"] <button>');

    // Elements that already carry an id keep their data-* as row decoration
    // and MUST NOT be duplicated as a standalone Stable data-attributes row —
    // the model already has a real selector for them.
    expect(inventory).toContain('#reset-btn');
    expect(inventory).not.toContain('[data-action="reset"] <button>');
  });

  test('does not emit the sentinel when only id-less data-attribute targets exist', () => {
    // A procedural widget whose rows are all data-only should not fall back
    // to "(no interactive elements detected)" — the extractor must surface
    // its stable data selectors instead.
    const html = '<li data-step-id="step-1">Only step</li>';
    const inventory = extractInteractiveElements(html);
    expect(inventory).toContain('[data-step-id="step-1"] <li>');
    expect(inventory).not.toBe('');
  });
});
