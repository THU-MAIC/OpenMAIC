#!/usr/bin/env node

import {
  buildCompleteScene,
  generateSceneActions,
  generateSceneContent,
  generateSceneOutlinesFromRequirements,
} from '@openmaic/generation';
import { validateScene } from '@openmaic/dsl';

function parseFlags(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error(`Expected a value after ${flag ?? 'the final flag'}`);
    }
    if (!['--requirement', '--endpoint', '--model', '--api-key'].includes(flag)) {
      throw new Error(`Unknown flag: ${flag}`);
    }
    values.set(flag, value);
  }

  for (const required of ['--requirement', '--endpoint', '--model']) {
    if (!values.get(required)) throw new Error(`Missing required flag: ${required}`);
  }
  return values;
}

const flags = parseFlags(process.argv.slice(2));
const endpoint = flags.get('--endpoint').replace(/\/+$/, '');
const model = flags.get('--model');
const apiKey = flags.get('--api-key');
const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};

const aiCall = async (systemPrompt, userPrompt) => {
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const response = await fetch(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Model endpoint returned ${response.status}: ${await response.text()}`);
  }
  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('Model endpoint response did not contain choices[0].message.content');
  }
  return content;
};

const result = await generateSceneOutlinesFromRequirements(
  { requirement: flags.get('--requirement') },
  undefined,
  undefined,
  aiCall,
  { logger },
);

if (!result.success || !result.data) {
  throw new Error(result.error || 'Outline generation failed');
}
if (result.data.outlines.length === 0) {
  throw new Error('Outline generation returned no outlines');
}
for (const outline of result.data.outlines) {
  if (!outline.title || !outline.type) {
    throw new Error('Outline generation returned an outline without a title or type');
  }
}

const slideOutline = result.data.outlines.find((outline) => outline.type === 'slide');
if (!slideOutline) throw new Error('Outline generation returned no slide outline');

const content = await generateSceneContent(slideOutline, aiCall, { logger });
if (!content || !('elements' in content)) {
  throw new Error('Slide content generation failed');
}
const actions = await generateSceneActions(slideOutline, content, aiCall, { logger });
const scene = buildCompleteScene(slideOutline, content, actions, 'node-smoke-stage', {
  sceneId: 'node-smoke-scene',
});
if (!scene) throw new Error('Slide scene assembly failed');

const sceneValidation = validateScene(scene);
if (!sceneValidation.valid) {
  throw new Error(
    `Generated scene failed DSL validation: ${JSON.stringify(sceneValidation.errors)}`,
  );
}

console.log(JSON.stringify({ ...result.data, scene, sceneValidation }, null, 2));
