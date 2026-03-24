import type { SceneOutline } from '../../../lib/types/generation';

/** Mock SceneOutline data matching lib/types/generation.ts:SceneOutline */
export const mockOutlines: SceneOutline[] = [
  {
    id: 'outline-0',
    type: 'slide' as const,
    title: '光合作用的基本概念',
    description: '介绍光合作用的定义和基本反应方程式',
    keyPoints: ['光合作用的定义', '反应方程式', '能量转换'],
    order: 0,
  },
  {
    id: 'outline-1',
    type: 'slide' as const,
    title: '光反应阶段',
    description: '光反应中光能的吸收与水的分解',
    keyPoints: ['光能吸收', '水的光解', 'ATP 与 NADPH 生成'],
    order: 1,
  },
  {
    id: 'outline-2',
    type: 'slide' as const,
    title: '暗反应阶段',
    description: '暗反应中碳固定与糖类合成',
    keyPoints: ['CO₂ 固定', 'C₃ 还原', '糖类合成'],
    order: 2,
  },
];
