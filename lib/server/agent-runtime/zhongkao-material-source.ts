import type { AgentSessionMaterial, AgentSessionMeta } from '@openmaic/storage';

import type { CurriculumSourceRef, CurriculumSourceVerifier } from '@/lib/zhongkao/curriculum';
import { CoachError } from '@/lib/zhongkao/coach-errors';

import { getSessionMaterial, resolveSessionMaterialText } from './session-materials';

const MATERIAL_TEXT_MAX_LENGTH = 8_000;

export interface VerifiedZhongkaoMaterialSource {
  materialId: string;
  displayName: string;
  source: CurriculumSourceRef;
  verifier: CurriculumSourceVerifier;
  text?: string;
}

export interface ZhongkaoMaterialSourceAdapter {
  resolve(materialId: string): Promise<VerifiedZhongkaoMaterialSource>;
}

export interface ZhongkaoMaterialSourceDependencies {
  ownerId: string;
  agentSessionId: string;
  sessionStore: Pick<
    { getSession(sessionId: string): Promise<AgentSessionMeta | null> },
    'getSession'
  >;
  getMaterial?: (sessionId: string, materialId: string) => Promise<AgentSessionMaterial | null>;
  readText?: (sessionId: string, textAssetId: string) => Promise<Buffer | null>;
}

function validMaterialId(value: string): boolean {
  return value.length > 0 && value.length <= 128 && value === value.trim();
}

function safeDisplayName(material: AgentSessionMaterial): string {
  const title = material.title
    ?.replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return title && title.length <= 180 ? title : material.id;
}

function exactVerifier(expected: CurriculumSourceRef): CurriculumSourceVerifier {
  return (candidate) =>
    candidate.type === expected.type && candidate.sourceId === expected.sourceId;
}

export function createZhongkaoMaterialSourceAdapter(
  deps: ZhongkaoMaterialSourceDependencies,
): ZhongkaoMaterialSourceAdapter {
  const getMaterial = deps.getMaterial ?? getSessionMaterial;
  const readText = deps.readText ?? resolveSessionMaterialText;

  return {
    async resolve(materialId) {
      if (!validMaterialId(materialId)) throw new CoachError('MATERIAL_SOURCE_NOT_VERIFIED');
      try {
        const session = await deps.sessionStore.getSession(deps.agentSessionId);
        if (!session || session.id !== deps.agentSessionId || session.ownerId !== deps.ownerId) {
          throw new CoachError('MATERIAL_SOURCE_NOT_VERIFIED');
        }

        const material = await getMaterial(deps.agentSessionId, materialId);
        if (!material || material.id !== materialId || material.sessionId !== deps.agentSessionId) {
          throw new CoachError('MATERIAL_SOURCE_NOT_VERIFIED');
        }

        const source: CurriculumSourceRef = {
          type: 'uploaded_material',
          sourceId: material.id,
        };
        let text: string | undefined;
        if (
          material.textAssetId &&
          (material.kind === 'extraction' ||
            material.kind === 'transcript' ||
            material.kind === 'web')
        ) {
          const bytes = await readText(deps.agentSessionId, material.textAssetId);
          const decoded = bytes?.toString('utf8').trim();
          if (decoded) text = decoded.slice(0, MATERIAL_TEXT_MAX_LENGTH);
        }

        return Object.freeze({
          materialId: material.id,
          displayName: safeDisplayName(material),
          source,
          verifier: exactVerifier(source),
          ...(text ? { text } : {}),
        });
      } catch (error) {
        if (error instanceof CoachError && error.code === 'MATERIAL_SOURCE_NOT_VERIFIED') {
          throw error;
        }
        throw new CoachError('MATERIAL_SOURCE_NOT_VERIFIED');
      }
    },
  };
}
