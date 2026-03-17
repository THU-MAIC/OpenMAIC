/**
 * Media (Image & Video) Generation Provider Type Definitions
 *
 * Unified types for image generation and video generation
 * with extensible architecture to support multiple providers.
 *
 * Currently Supported Image Providers:
 * - Seedream (ByteDance SDXL-based image generation)
 * - Qwen Image (Alibaba Cloud Wanx image generation)
 * - Nano Banana (Lightweight image generation via Banana.dev)
 *
 * Currently Supported Video Providers (Phase 2):
 * - Seedance (ByteDance video generation)
 * - Kling (Kuaishou video generation)
 * - Veo (Google DeepMind video generation)
 * - Sora (OpenAI video generation)
 *
 * HOW TO ADD A NEW PROVIDER:
 *
 * Step 1: Add provider ID to the union type
 *   - For Image: Add to ImageProviderId below
 *   - For Video: Add to VideoProviderId below
 *
 * Step 2: Add provider configuration to constants.ts
 *   - Define provider metadata (name, icon, aspect ratios, styles, etc.)
 *   - Add to IMAGE_PROVIDERS or VIDEO_PROVIDERS registry
 *
 * Step 3: Implement provider logic in image-providers.ts or video-providers.ts
 *   - Add case to generateImage() or generateVideo() switch statement
 *   - Implement API call logic for the new provider
 *   - For async task-based providers, implement MediaTaskAdapter
 *
 * Step 4: Add i18n translations
 *   - Add provider name translations in lib/i18n.ts
 *   - Format: `provider{ProviderName}Image` or `provider{ProviderName}Video`
 *
 * Step 5 (Optional): Add provider-specific options
 *   - Extend ImageGenerationOptions or VideoGenerationOptions as needed
 *   - Document provider-specific parameters in JSDoc
 *
 * Example: Adding DALL-E Image Provider
 * =======================================
 * 1. Add 'dall-e' to ImageProviderId union type
 * 2. In constants.ts:
 *    IMAGE_PROVIDERS['dall-e'] = {
 *      id: 'dall-e',
 *      name: 'DALL-E',
 *      requiresApiKey: true,
 *      defaultBaseUrl: 'https://api.openai.com/v1',
 *      icon: '/openai.svg',
 *      supportedAspectRatios: ['1:1', '16:9', '9:16'],
 *      supportedStyles: ['natural', 'vivid'],
 *      maxResolution: { width: 1024, height: 1024 }
 *    }
 * 3. In image-providers.ts:
 *    case 'dall-e':
 *      return await generateDallEImage(config, options);
 * 4. In i18n.ts:
 *    providerDallEImage: 'DALL-E' / 'DALL-E 图像生成'
 */

// ============================================================================
// Image Generation Types
// ============================================================================

/**
 * Image Provider IDs
 *
 * Add new image providers here as union members.
 * Keep in sync with IMAGE_PROVIDERS registry in constants.ts
 */
export type ImageProviderId = 'seedream' | 'qwen-image' | 'nano-banana';
// Add new image providers below (uncomment and modify):
// | 'dall-e'
// | 'midjourney'
// | 'stable-diffusion'

/**
 * Image Provider Configuration
 *
 * Describes the capabilities and metadata of an image generation provider.
 * Used to populate UI controls and validate generation requests.
 */
/** Model metadata for an image generation model */
export interface ImageModelInfo {
  /** Model identifier passed to the API */
  id: string;
  /** Human-readable display name */
  name: string;
}

export interface ImageProviderConfig {
  /** Unique provider identifier */
  id: ImageProviderId;
  /** Human-readable provider name */
  name: string;
  /** Whether the provider requires an API key for authentication */
  requiresApiKey: boolean;
  /** Default API base URL (can be overridden in user settings) */
  defaultBaseUrl?: string;
  /** Path to provider icon asset */
  icon?: string;
  /** Available models for this provider */
  models: ImageModelInfo[];
  /** Aspect ratios supported by this provider */
  supportedAspectRatios: Array<'16:9' | '4:3' | '1:1' | '9:16'>;
  /** Optional artistic styles supported by this provider */
  supportedStyles?: string[];
  /** Maximum supported output resolution */
  maxResolution?: {
    width: number;
    height: number;
  };
}

/**
 * Image Generation Configuration
 *
 * Runtime configuration for making image generation API calls.
 * Combines provider selection with authentication credentials.
 */
export interface ImageGenerationConfig {
  /** Which image provider to use */
  providerId: ImageProviderId;
  /** API key for authentication */
  apiKey: string;
  /** Optional override for the provider's base URL */
  baseUrl?: string;
  /** Optional model ID override (uses provider default if omitted) */
  model?: string;
}

/**
 * Image Generation Options
 *
 * Parameters for a single image generation request.
 * Passed alongside ImageGenerationConfig to the provider.
 */
export interface ImageGenerationOptions {
  /** Text prompt describing the desired image */
  prompt: string;
  /** Optional negative prompt to exclude undesired elements */
  negativePrompt?: string;
  /** Desired output width in pixels */
  width?: number;
  /** Desired output height in pixels */
  height?: number;
  /** Desired aspect ratio (provider will calculate dimensions if width/height not set) */
  aspectRatio?: '16:9' | '4:3' | '1:1' | '9:16';
  /** Optional artistic style (must be supported by the chosen provider) */
  style?: string;
}

/**
 * Image Generation Result
 *
 * The output of a successful image generation request.
 * Contains either a URL or base64-encoded image data (or both).
 */
export interface ImageGenerationResult {
  /** URL to the generated image (if hosted by the provider) */
  url?: string;
  /** Base64-encoded image data (if returned inline) */
  base64?: string;
  /** Width of the generated image in pixels */
  width: number;
  /** Height of the generated image in pixels */
  height: number;
}

// ============================================================================
// Video Generation Types (Phase 2)
// ============================================================================

/**
 * Video Provider IDs
 *
 * Add new video providers here as union members.
 * Keep in sync with VIDEO_PROVIDERS registry in constants.ts
 */
export type VideoProviderId = 'seedance' | 'kling' | 'veo' | 'sora';
// Add new video providers below (uncomment and modify):
// | 'runway'
// | 'pika'

/**
 * Video Provider Configuration
 *
 * Describes the capabilities and metadata of a video generation provider.
 * Used to populate UI controls and validate generation requests.
 */
/** Model metadata for a video generation model (same shape as image) */
export type VideoModelInfo = ImageModelInfo;

export interface VideoProviderConfig {
  /** Unique provider identifier */
  id: VideoProviderId;
  /** Human-readable provider name */
  name: string;
  /** Whether the provider requires an API key for authentication */
  requiresApiKey: boolean;
  /** Default API base URL (can be overridden in user settings) */
  defaultBaseUrl?: string;
  /** Path to provider icon asset */
  icon?: string;
  /** Available models for this provider */
  models: VideoModelInfo[];
  /** Aspect ratios supported by this provider */
  supportedAspectRatios: Array<'16:9' | '4:3' | '1:1' | '9:16' | '3:4' | '21:9'>;
  /** Supported video durations in seconds */
  supportedDurations?: number[];
  /** Supported output resolutions */
  supportedResolutions?: Array<'480p' | '720p' | '1080p'>;
  /** Maximum video duration in seconds */
  maxDuration?: number;
}

/**
 * Video Generation Configuration
 *
 * Runtime configuration for making video generation API calls.
 * Combines provider selection with authentication credentials.
 */
export interface VideoGenerationConfig {
  /** Which video provider to use */
  providerId: VideoProviderId;
  /** API key for authentication */
  apiKey: string;
  /** Optional override for the provider's base URL */
  baseUrl?: string;
  /** Optional model ID override (uses provider default if omitted) */
  model?: string;
}

/**
 * Video Generation Options
 *
 * Parameters for a single video generation request.
 * Passed alongside VideoGenerationConfig to the provider.
 */
export interface VideoGenerationOptions {
  /** Text prompt describing the desired video */
  prompt: string;
  /** Desired video duration in seconds */
  duration?: number;
  /** Desired aspect ratio */
  aspectRatio?: '16:9' | '4:3' | '1:1' | '9:16' | '3:4' | '21:9';
  /** Desired output resolution */
  resolution?: '480p' | '720p' | '1080p';
}

/**
 * Video Generation Result
 *
 * The output of a successful video generation request.
 * Contains the URL to the generated video along with metadata.
 */
export interface VideoGenerationResult {
  /** URL to the generated video */
  url: string;
  /** Duration of the generated video in seconds */
  duration: number;
  /** Width of the generated video in pixels */
  width: number;
  /** Height of the generated video in pixels */
  height: number;
  /** Optional URL to a poster/thumbnail image for the video */
  poster?: string;
}

// ============================================================================
// Shared / Cross-cutting Types
// ============================================================================

/**
 * Media Generation Request
 *
 * A unified request type used by the whiteboard/canvas to request
 * media generation. Maps to either image or video generation internally.
 */
export interface MediaGenerationRequest {
  /** Type of media to generate */
  type: 'image' | 'video';
  /** Text prompt describing the desired media */
  prompt: string;
  /** Identifier for the target element on the canvas (e.g. "gen_img_1") */
  elementId: string;
  /** Desired aspect ratio */
  aspectRatio?: '16:9' | '4:3' | '1:1' | '9:16';
  /** Optional artistic style hint */
  style?: string;
}

/**
 * Media Task Adapter
 *
 * Generic interface for providers that use an asynchronous task pattern
 * (submit task, then poll for completion). Many image/video generation
 * APIs are async — this adapter abstracts that pattern.
 *
 * @template TOptions - The generation options type (e.g. ImageGenerationOptions)
 * @template TResult - The generation result type (e.g. ImageGenerationResult)
 */
export interface MediaTaskAdapter<TOptions, TResult> {
  /**
   * Submit a generation task to the provider.
   *
   * @param options - Generation options for the task
   * @returns A task ID that can be used to poll for status
   */
  submitTask(options: TOptions): Promise<string>;

  /**
   * Poll the status of a previously submitted task.
   *
   * @param taskId - The task ID returned by submitTask()
   * @returns The generation result if complete, or null if still processing
   */
  pollTaskStatus(taskId: string): Promise<TResult | null>;
}
