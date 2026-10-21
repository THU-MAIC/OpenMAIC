import { Type, type Static } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';

import {
  storeGeneratedAsset,
  type StoreGeneratedAssetInput,
} from '@/lib/server/store-generated-asset';
import { COURSE_STAGE_ID_DESCRIPTION } from './course-stage';
import {
  resolveRawMaterial,
  sessionRowRawLookup,
  type MaterialScope,
  type RawMaterialHandle,
} from './material-resolver';
import { getSessionMaterial, resolveSessionMaterialRawAsset } from './session-materials';

const Params = Type.Object({
  materialId: Type.String({
    description: 'The id of an image, video or audio material, from list_materials.',
  }),
  stageId: Type.String({ description: COURSE_STAGE_ID_DESCRIPTION }),
  scope: Type.Optional(
    Type.Union([Type.Literal('session'), Type.Literal('library')], {
      description:
        "'session' (default): a material of this conversation. 'library': any material in the " +
        "user's knowledge base, attached or not; using it does not attach it.",
    }),
  ),
});

export interface MaterialMediaDeps {
  sessionId: string;
  /**
   * The run's owner: the owner of every stage the course toolset lets the
   * run write. The copy is allocated in that owner's partition (after a claim,
   * the account's).
   */
  ownerId?: string;
  /** Test seam; defaults to the pool allocation generated media use. */
  storeAsset?: typeof storeGeneratedAsset;
  /** Resolve a material id of the session; defaults to the shared resolver. */
  resolveMaterial?: (
    sessionId: string,
    materialId: string,
    scope: MaterialScope,
  ) => Promise<RawMaterialHandle | null>;
  /** Session-row seams, kept for the tests written against them. */
  getMaterial?: typeof getSessionMaterial;
  readRawBytes?: typeof resolveSessionMaterialRawAsset;
}

export function buildMaterialMediaTool(deps: MaterialMediaDeps): AgentTool<never, never> {
  return {
    name: 'use_material_media',
    label: 'Use material media',
    description:
      'Copy one image, video or audio material into the course and return a new src for a media ' +
      'element of the target stage. Put the src on the element with patch_stage: that write is ' +
      'what keeps the copy; a copy no page names expires. The copy is independent of the ' +
      'material, so deleting the material later never breaks the course. With scope library it ' +
      'uses a knowledge-base material this conversation has not attached, without attaching it.',
    parameters: Params,
    async execute(_callId: string, params: Static<typeof Params>, signal?: AbortSignal) {
      // A linked library source or derivative, or a session row (RFC #1716 §4).
      const resolve =
        deps.resolveMaterial ??
        (deps.getMaterial || deps.readRawBytes
          ? sessionRowRawLookup(deps.getMaterial ?? getSessionMaterial, async (record) =>
              record.rawAssetId
                ? (deps.readRawBytes ?? resolveSessionMaterialRawAsset)(
                    deps.sessionId,
                    record.rawAssetId,
                  )
                : null,
            )
          : resolveRawMaterial);
      const material = await resolve(deps.sessionId, params.materialId, params.scope ?? 'session');
      if (!material?.hasBytes) {
        return {
          content: [{ type: 'text', text: 'Media material not found or has no media bytes.' }],
          details: { materialId: params.materialId },
          isError: true,
        };
      }
      const source = await material.read();
      if (!source) {
        return {
          content: [{ type: 'text', text: 'Media bytes are unavailable.' }],
          details: { materialId: material.id },
          isError: true,
        };
      }
      if (signal?.aborted) throw new Error('aborted');
      if (!/^(image|video|audio)\//.test(source.mime)) {
        return {
          content: [
            { type: 'text', text: 'Only image, video, or audio materials can be promoted.' },
          ],
          details: { materialId: material.id, mimeType: source.mime },
          isError: true,
        };
      }
      if (!deps.ownerId) {
        throw new Error('Material media cannot be copied without the run owner');
      }
      // Copy-on-use (RFC #1716 §4): a new pending entry of its own, even for
      // the same owner and the same bytes, so the course never depends on the
      // material's entry living on. The document write naming it commits it
      // and records the course's reference (#1473); until then it is pending
      // and expires. Nothing here deletes it on a later failure: once the id
      // is returned a write may already name it, so expiry is the only
      // cleanup that is always safe.
      const stored = await (deps.storeAsset ?? storeGeneratedAsset)({
        ownerId: deps.ownerId,
        stageId: params.stageId,
        bytes: source.bytes,
        mimeType: source.mime,
        kind: mediaKindOf(source.mime),
      });
      if (stored.status === 'refused') {
        return {
          content: [
            {
              type: 'text',
              text: 'The asset store has no room for this media. Ask the user to free space, then try again.',
            },
          ],
          details: { materialId: material.id, status: 'storage-full' },
          isError: true,
        };
      }
      if (signal?.aborted) throw new Error('aborted');
      const src = stored.assetId;
      return {
        content: [
          {
            type: 'text',
            text: `Use src "${src}" for the slide media element, written with patch_stage.`,
          },
        ],
        details: {
          materialId: material.id,
          src,
          mimeType: source.mime,
          bytes: source.bytes.byteLength,
        },
      };
    },
  } as unknown as AgentTool<never, never>;
}

function mediaKindOf(mime: string): StoreGeneratedAssetInput['kind'] {
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'image';
}

export const MATERIAL_MEDIA_TOOL_NAME = 'use_material_media' as const;
