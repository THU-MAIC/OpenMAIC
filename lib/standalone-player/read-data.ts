import type { ClassroomManifest, ManifestScene } from '@/lib/export/classroom-zip-types';
import {
  STANDALONE_CONFIG_ELEMENT_ID,
  STANDALONE_MANIFEST_ELEMENT_ID,
  type StandalonePlayerConfig,
} from '@/lib/export/standalone-html/contract';
import { orderManifestScenes } from '@/lib/export/standalone-html/order-scenes';

function readJson<T>(doc: Document, id: string): T {
  const element = doc.getElementById(id);
  if (!element?.textContent) throw new Error(`Missing embedded data: #${id}`);
  return JSON.parse(element.textContent) as T;
}

export interface PlayerData {
  manifest: ClassroomManifest;
  scenes: ManifestScene[];
  config: StandalonePlayerConfig;
}

/** Read the classroom and player config embedded in the exported document. */
export function readPlayerData(doc: Document): PlayerData {
  const manifest = readJson<ClassroomManifest>(doc, STANDALONE_MANIFEST_ELEMENT_ID);
  const config = readJson<StandalonePlayerConfig>(doc, STANDALONE_CONFIG_ELEMENT_ID);
  return { manifest, scenes: orderManifestScenes(manifest.scenes ?? []), config };
}
