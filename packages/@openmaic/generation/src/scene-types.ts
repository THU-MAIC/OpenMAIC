import type {
  Action,
  InteractiveContent,
  PBLContent,
  PBLProject,
  PPTElement,
  QuizContent,
  QuizQuestion,
  Scene,
  SlideBackground,
  SlideContent,
  WidgetConfigBase,
  WidgetType,
} from '@openmaic/dsl';

/** AI-generated slide payload before it is assembled into a scene. */
export interface GeneratedSlideContent {
  elements: PPTElement[];
  background?: SlideBackground;
  remark?: string;
}

/** AI-generated quiz payload before it is assembled into a scene. */
export interface GeneratedQuizContent {
  questions: QuizQuestion[];
}

export interface ScientificModel {
  core_formulas: string[];
  mechanism: string[];
  constraints: string[];
  forbidden_errors: string[];
}

/** AI-generated interactive payload before it is assembled into a scene. */
export interface GeneratedInteractiveContent {
  html: string;
  scientificModel?: ScientificModel;
  widgetType?: WidgetType;
  widgetConfig?: WidgetConfigBase;
}

/** AI-generated PBL payload. The persisted project contract is owned by the DSL. */
export interface GeneratedPBLContent {
  projectV2: PBLProject;
}

export type GeneratedSceneContent =
  | GeneratedSlideContent
  | GeneratedQuizContent
  | GeneratedInteractiveContent
  | GeneratedPBLContent;

export type CompleteSceneContent = SlideContent | QuizContent | InteractiveContent | PBLContent;

/** Scene assembled by the package, including the originating outline identity. */
export type CompleteScene = Scene<Action, CompleteSceneContent> & { outlineId: string };

/** Widget configuration emitted by the model and normalized by the scene layer. */
export type WidgetConfig = WidgetConfigBase;
