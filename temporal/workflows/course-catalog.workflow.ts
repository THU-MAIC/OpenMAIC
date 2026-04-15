import { proxyActivities } from '@temporalio/workflow';
import type {
  GenerateCatalogMetadataParams,
  InsertCourseAndGenerateTagsParams,
} from '../activities/course-catalog.activities';

const { insertCourseAndGenerateTagsActivity, generateCatalogMetadataForCourseActivity } =
  proxyActivities<{
    insertCourseAndGenerateTagsActivity(params: InsertCourseAndGenerateTagsParams): Promise<void>;
    generateCatalogMetadataForCourseActivity(params: GenerateCatalogMetadataParams): Promise<void>;
  }>({
    startToCloseTimeout: '10 minutes',
    retry: {
      maximumAttempts: 3,
      initialInterval: '5s',
      backoffCoefficient: 2,
    },
  });

/**
 * Workflow triggered at the end of classroom generation.
 * Inserts the course into the catalog and generates AI tags.
 */
export async function insertCourseAndGenerateTagsWorkflow(
  params: InsertCourseAndGenerateTagsParams,
): Promise<void> {
  await insertCourseAndGenerateTagsActivity(params);
}

/**
 * Workflow triggered after POST /api/courses (client-side course upload).
 * Generates catalog metadata and classification tags.
 */
export async function generateCatalogMetadataWorkflow(
  params: GenerateCatalogMetadataParams,
): Promise<void> {
  await generateCatalogMetadataForCourseActivity(params);
}
