export interface ProjectHeroDetails {
  title: string;
  description: string;
  gains?: readonly string[];
  learningObjective?: string;
  instructorName: string;
  milestoneCount: number;
  taskCount: number;
  scenario?: { characterName: string; roleplayCount: number };
}
