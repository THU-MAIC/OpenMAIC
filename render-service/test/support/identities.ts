import type { RenderCoordinator } from '../../src/render-coordinator.js';
import {
  requireAdmissionIdentity,
  requireRenderOwnerId,
  type RenderOptions,
} from '../../src/types.js';

export const admission = requireAdmissionIdentity;
export const owner = requireRenderOwnerId;

export function submitRender(
  coordinator: RenderCoordinator,
  identity: string,
  projectDir: string,
  options: RenderOptions,
  ownerId = identity,
): Promise<string> {
  return coordinator.submit({
    reservation: coordinator.reserve(admission(identity)),
    ownerId: owner(ownerId),
    projectDir,
    options,
  });
}
