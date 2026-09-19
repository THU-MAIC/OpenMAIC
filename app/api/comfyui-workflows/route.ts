/**
 * GET /api/comfyui-workflows
 *
 * Returns a list of ComfyUI workflow JSON files found in the Next.js
 * public/ directory, with display names derived from their filenames.
 * Discovery logic lives in lib/media/comfyui-workflows.ts and is shared
 * with the ComfyUI image adapter, so the list returned here is always
 * exactly what the adapter will accept as a workflow id.
 *
 * Response: { workflows: Array<{ id: string; name: string }> }
 */

import { NextResponse } from 'next/server';
import { listComfyuiWorkflows } from '@/lib/media/comfyui-workflows';

export async function GET() {
  try {
    return NextResponse.json({ workflows: await listComfyuiWorkflows() });
  } catch (err) {
    console.error('[ComfyUI Workflows API] Failed to list workflows:', err);
    return NextResponse.json({ workflows: [] });
  }
}
