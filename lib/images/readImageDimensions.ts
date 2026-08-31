/**
 * Reads width/height directly from PNG/JPEG header bytes - the
 * generation API doesn't return dimensions explicitly, and pulling in
 * an image-metadata library for two header formats isn't worth a new
 * dependency. Returns null (never throws) on anything it can't parse,
 * so the caller decides how to treat "couldn't determine dimensions."
 */
export function readImageDimensions(bytes: Buffer, mimeType: string): { width: number; height: number } | null {
  if (mimeType === "image/png") return readPngDimensions(bytes);
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") return readJpegDimensions(bytes);
  return null;
}

function readPngDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (!isPng) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Scans JPEG markers for the first Start-Of-Frame segment (SOF0/1/2/3, skipping DHT/JPG markers), which carries the real pixel dimensions. */
function readJpegDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = bytes[offset + 1];
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    const segmentLength = bytes.readUInt16BE(offset + 2);
    offset += 2 + segmentLength;
  }
  return null;
}
