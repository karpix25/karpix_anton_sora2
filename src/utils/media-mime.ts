import path from 'node:path';

const extensionMimeTypes: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};

export function detectImageMimeType(buffer: Buffer, fileName = '', fallbackMimeType = ''): string {
  if (buffer.length >= 12) {
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return 'image/jpeg';
    }

    if (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
    ) {
      return 'image/png';
    }

    if (
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP'
    ) {
      return 'image/webp';
    }

    const gifHeader = buffer.toString('ascii', 0, 6);
    if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') {
      return 'image/gif';
    }

    const brand = buffer.toString('ascii', 8, 12);
    if (brand === 'heic' || brand === 'heix') {
      return 'image/heic';
    }
    if (brand === 'heif' || brand === 'hevc') {
      return 'image/heif';
    }
  }

  const fallback = String(fallbackMimeType || '').trim().toLowerCase();
  if (fallback.startsWith('image/') && fallback !== 'application/octet-stream') {
    return fallback;
  }

  const extension = path.extname(fileName).trim().toLowerCase();
  return extensionMimeTypes[extension] || '';
}

export function isSupportedGeminiImageMimeType(mimeType: string): boolean {
  return ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(
    String(mimeType || '').trim().toLowerCase()
  );
}
