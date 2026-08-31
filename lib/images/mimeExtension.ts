/** Maps a generated image's real mime type to a file extension for its artifact path - the provider decides the format, never the model/user. */
export function mimeTypeExtension(mimeType: string): string {
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") return "jpg";
  return "png";
}

/** The inverse - an existing artifact's mime type isn't stored separately, so it's derived from the extension buildArtifactPath already gave its file. */
export function extensionMimeType(path: string): string {
  return path.endsWith(".jpg") || path.endsWith(".jpeg") ? "image/jpeg" : "image/png";
}
