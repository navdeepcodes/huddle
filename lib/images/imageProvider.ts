/**
 * Phase 36 STEP 4: the smallest image-provider abstraction - the
 * agent/tool layer only ever sees this shape, never a model name, GPU,
 * endpoint, or provider-specific response format. Mirrors the existing
 * VisionProvider interface's own reasoning (lib/preview/visionProvider.ts)
 * for the same class of problem, one level removed: swapping the
 * backing model/provider later means writing a new file here, not
 * touching the tool or agent loop.
 */
export interface GeneratedImage {
  base64: string;
  mimeType: string;
  width: number;
  height: number;
}

export interface GenerateImageRequest {
  prompt: string;
  /** e.g. "16:9", "1:1", "4:3" - validated against a known set before reaching the provider. */
  aspectRatio?: string;
}

export interface EditImageRequest {
  instruction: string;
  sourceBase64: string;
  sourceMimeType: string;
}

export interface ImageProvider {
  readonly id: string;
  generateImage(request: GenerateImageRequest): Promise<GeneratedImage>;
  editImage(request: EditImageRequest): Promise<GeneratedImage>;
}
