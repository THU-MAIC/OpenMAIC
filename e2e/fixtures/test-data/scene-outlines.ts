import type { SceneOutline } from '../../../lib/types/generation';

/** Mock SceneOutline data matching lib/types/generation.ts:SceneOutline */
export const mockOutlines: SceneOutline[] = [
  {
    id: 'outline-0',
    type: 'slide' as const,
    title: '',
    description: '',
    keyPoints: ['', '', ''],
    order: 0,
  },
  {
    id: 'outline-1',
    type: 'slide' as const,
    title: '',
    description: '',
    keyPoints: ['', '', 'ATP  NADPH '],
    order: 1,
  },
  {
    id: 'outline-2',
    type: 'slide' as const,
    title: '',
    description: '',
    keyPoints: ['CO₂ ', 'C₃ ', ''],
    order: 2,
  },
];
