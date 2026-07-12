/**
 * Widget Configuration Types for Ultra Interaction Mode
 */

// ==================== Base Types ====================

export type WidgetType =
  | 'simulation'
  | 'diagram'
  | 'code'
  | 'game'
  | 'visualization3d'
  | 'procedural-skill';

// ==================== Simulation Widget ====================

export interface SimulationVariable {
  name: string;
  label: string;
  min: number;
  max: number;
  default: number;
  unit?: string;
  step?: number;
}

export interface SimulationConfig {
  type: 'simulation';
  concept: string;
  description: string;
  variables: SimulationVariable[];
  presets?: Array<{
    name: string;
    variables: Record<string, number>;
  }>;
}

// ==================== Diagram Widget ====================

export interface DiagramNode {
  id: string;
  label: string;
  position?: { x: number; y: number };
  details?: string;
  type?: 'default' | 'decision' | 'start' | 'end';
}

export interface DiagramEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
}

export interface DiagramConfig {
  type: 'diagram';
  diagramType: 'flowchart' | 'mindmap' | 'hierarchy' | 'system';
  description: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  revealOrder?: string[]; // Node IDs in reveal sequence
}

// ==================== Code Widget ====================

export interface CodeTestCase {
  id: string;
  input: string;
  expected: string;
  description?: string;
  isHidden?: boolean;
}

export interface CodeConfig {
  type: 'code';
  language: 'python' | 'javascript' | 'typescript' | 'java' | 'cpp';
  description: string;
  starterCode: string;
  testCases: CodeTestCase[];
  hints: string[];
  solution: string;
}

// ==================== Game Widget ====================

export interface GameQuestion {
  id: string;
  question: string;
  type: 'single' | 'multiple';
  options: string[];
  correct: number | number[];
  explanation?: string;
  points?: number;
}

export interface GameConfig {
  type: 'game';
  gameType: 'quiz' | 'puzzle' | 'strategy' | 'card';
  description: string;
  questions?: GameQuestion[];
  scoring: {
    correctPoints: number;
    speedBonus?: number;
    comboMultiplier?: number;
    penalty?: number;
  };
  achievements?: Array<{
    id: string;
    name: string;
    description: string;
    icon: string;
    condition: string;
  }>;
}

// ==================== 3D Visualization Widget ====================

export interface Visualization3DObject {
  id: string;
  type: 'sphere' | 'box' | 'cylinder' | 'cone' | 'torus' | 'plane' | 'custom';
  name?: string;
  position?: { x: number; y: number; z: number };
  rotation?: { x: number; y: number; z: number };
  scale?: number | { x: number; y: number; z: number };
  material?: {
    type: 'basic' | 'lambert' | 'phong' | 'standard' | 'emissive';
    color?: string;
    emissive?: string;
    wireframe?: boolean;
    transparent?: boolean;
    opacity?: number;
  };
  // For animated objects
  animation?: {
    type: 'orbit' | 'rotate' | 'bounce' | 'pulse';
    speed?: number;
    axis?: 'x' | 'y' | 'z';
  };
  // For hierarchical objects
  children?: Visualization3DObject[];
}

export interface Visualization3DInteraction {
  type: 'orbit' | 'zoom' | 'pan' | 'slider' | 'button' | 'toggle';
  target?: string; // Object ID or 'camera'
  label?: string;
  param?: string;
  min?: number;
  max?: number;
  default?: number;
  step?: number;
}

export interface Visualization3DConfig {
  type: 'visualization3d';
  visualizationType: 'molecular' | 'solar' | 'anatomy' | 'geometry' | 'physics' | 'custom';
  description: string;
  objects: Visualization3DObject[];
  interactions?: Visualization3DInteraction[];
  camera?: {
    position?: { x: number; y: number; z: number };
    target?: { x: number; y: number; z: number };
    fov?: number;
  };
  lighting?: {
    ambient?: { color?: string; intensity?: number };
    directional?: Array<{
      color?: string;
      intensity?: number;
      position?: { x: number; y: number; z: number };
    }>;
    point?: Array<{
      color?: string;
      intensity?: number;
      position?: { x: number; y: number; z: number };
    }>;
  };
  presets?: Array<{
    name: string;
    description?: string;
    state: Record<string, unknown>;
  }>;
}

// ==================== Procedural Skill Widget ====================

export interface ProceduralSkillStep {
  id: string;
  title: string;
  description: string;
  tools?: string[];
  successCriteria?: string[];
}

export interface ProceduralSkillConfig {
  type: 'procedural-skill';
  task: string;
  description: string;
  tools?: string[];
  steps: ProceduralSkillStep[];
  successCriteria?: string[];
}

// ==================== Union Types ====================

export type WidgetConfig =
  | SimulationConfig
  | DiagramConfig
  | CodeConfig
  | GameConfig
  | Visualization3DConfig
  | ProceduralSkillConfig;
