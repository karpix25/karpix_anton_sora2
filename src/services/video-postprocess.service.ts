import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import fs from 'fs-extra';
import type { ReferenceTextOverlay } from '../domain/reference-library.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.resolve(__dirname, '../../data/generated-video-work');
const defaultFontFamily = 'Arial,Apple Color Emoji,Segoe UI Emoji,Noto Color Emoji,Noto Emoji';
const overlaySafeMarginPercent = 0.03;

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const process = spawn('ffmpeg', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    process.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    process.on('error', (error) => {
      reject(new Error(`Не удалось запустить ffmpeg: ${error.message}`));
    });

    process.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`ffmpeg завершился с ошибкой: ${stderr.trim() || `code ${code}`}`));
    });
  });
}

function escapeFilterValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/,/g, '\\,');
}

function escapeDrawtextExpression(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,');
}

function normalizeFfmpegColor(value: string, fallback: string): string {
  const normalized = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(normalized)) {
    return `0x${normalized.slice(1).toUpperCase()}`;
  }

  if (/^0x[0-9a-f]{6}$/i.test(normalized)) {
    return normalized.toUpperCase();
  }

  return fallback;
}

function wrapLineByWords(line: string, maxCharsPerLine: number): string[] {
  const words = line.trim().split(/\s+/).filter(Boolean);
  if (!words.length) {
    return [''];
  }

  const lines: string[] = [];
  let current = '';
  let currentLen = 0;

  for (const word of words) {
    const glyphs = Array.from(word);
    const wordLen = glyphs.length;

    if (wordLen > maxCharsPerLine) {
      if (current) {
        lines.push(current);
        current = '';
        currentLen = 0;
      }

      for (let index = 0; index < glyphs.length; index += maxCharsPerLine) {
        lines.push(glyphs.slice(index, index + maxCharsPerLine).join(''));
      }
      continue;
    }

    if (!current) {
      current = word;
      currentLen = wordLen;
      continue;
    }

    if (currentLen + 1 + wordLen <= maxCharsPerLine) {
      current += ` ${word}`;
      currentLen += 1 + wordLen;
      continue;
    }

    lines.push(current);
    current = word;
    currentLen = wordLen;
  }

  if (current) {
    lines.push(current);
  }

  return lines;
}

function wrapOverlayText(text: string, maxCharsPerLine: number): string {
  const normalizedMaxChars = Math.max(10, maxCharsPerLine);
  const sourceLines = text.replace(/\r/g, '').split('\n');
  const wrappedLines = sourceLines.flatMap((line) => wrapLineByWords(line, normalizedMaxChars));
  return wrappedLines.join('\n');
}

function estimateMaxCharsPerLine(fontSizePercent: number): number {
  const normalizedSize = Math.max(0.02, fontSizePercent);
  const estimated = Math.round(30 * (0.04 / normalizedSize));
  return Math.max(14, Math.min(44, estimated));
}

function getAnchorExpressions(overlay: ReferenceTextOverlay): { x: string; y: string } {
  const xBase = `w*${overlay.xPercent.toFixed(4)}`;
  const yBase = `h*${overlay.yPercent.toFixed(4)}`;

  switch (overlay.anchor) {
    case 'top-left':
      return { x: xBase, y: yBase };
    case 'top-center':
      return { x: `${xBase}-text_w/2`, y: yBase };
    case 'top-right':
      return { x: `${xBase}-text_w`, y: yBase };
    case 'center-left':
      return { x: xBase, y: `${yBase}-text_h/2` };
    case 'center':
      return { x: `${xBase}-text_w/2`, y: `${yBase}-text_h/2` };
    case 'center-right':
      return { x: `${xBase}-text_w`, y: `${yBase}-text_h/2` };
    case 'bottom-left':
      return { x: xBase, y: `${yBase}-text_h` };
    case 'bottom-center':
      return { x: `${xBase}-text_w/2`, y: `${yBase}-text_h` };
    case 'bottom-right':
      return { x: `${xBase}-text_w`, y: `${yBase}-text_h` };
    default:
      return { x: `${xBase}-text_w/2`, y: yBase };
  }
}

function getBoundedAnchorExpressions(overlay: ReferenceTextOverlay): { x: string; y: string } {
  const { x, y } = getAnchorExpressions(overlay);
  const margin = `h*${overlaySafeMarginPercent.toFixed(4)}`;

  return {
    x: `max(${margin},min(${x},w-text_w-${margin}))`,
    y: `max(${margin},min(${y},h-text_h-${margin}))`,
  };
}

async function writeOverlayTextFiles(taskId: string, overlays: ReferenceTextOverlay[]): Promise<string[]> {
  const overlayDir = path.join(dataDir, `${taskId}-overlays`);
  await fs.ensureDir(overlayDir);

  const files: string[] = [];
  for (let index = 0; index < overlays.length; index += 1) {
    const overlay = overlays[index];
    if (!overlay) {
      continue;
    }

    const filePath = path.join(overlayDir, `${index + 1}.txt`);
    const wrappedText = wrapOverlayText(overlay.text, estimateMaxCharsPerLine(overlay.fontSizePercent));
    await fs.writeFile(filePath, wrappedText, 'utf8');
    files.push(filePath);
  }

  return files;
}

function buildDrawTextFilters(overlays: ReferenceTextOverlay[], textFiles: string[]): string[] {
  return overlays.map((overlay, index) => {
    const textFile = textFiles[index];
    const { x, y } = getBoundedAnchorExpressions(overlay);
    const safeX = escapeDrawtextExpression(x);
    const safeY = escapeDrawtextExpression(y);
    const textColor = normalizeFfmpegColor(overlay.textColor, '0xFFFFFF');
    const boxColor = `${normalizeFfmpegColor(overlay.boxColor, '0x000000')}@${Math.max(0, Math.min(1, overlay.boxOpacity)).toFixed(2)}`;
    const params = [
      `font='${escapeFilterValue(defaultFontFamily)}'`,
      `textfile='${escapeFilterValue(textFile || '')}'`,
      `reload=1`,
      `fontsize=h*${Math.max(0.02, overlay.fontSizePercent).toFixed(4)}`,
      `fontcolor=${textColor}`,
      `x=${safeX}`,
      `y=${safeY}`,
      `fix_bounds=1`,
      `box=${overlay.box ? 1 : 0}`,
      `boxcolor=${boxColor}`,
      `boxborderw=12`,
      `line_spacing=8`,
      `enable='between(t,${overlay.startSeconds.toFixed(3)},${overlay.endSeconds.toFixed(3)})'`,
    ];

    return `drawtext=${params.join(':')}`;
  });
}

export class VideoPostprocessService {
  public static async applyAudioTrack(input: {
    taskId: string;
    generatedVideoUrl: string;
    audioFilePath: string;
    textOverlays?: ReferenceTextOverlay[];
  }): Promise<string> {
    await fs.ensureDir(dataDir);

    const outputPath = path.join(dataDir, `${input.taskId}.mp4`);

    if (!input.textOverlays?.length) {
      await runFfmpeg([
        '-y',
        '-i',
        input.generatedVideoUrl,
        '-i',
        input.audioFilePath,
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-shortest',
        '-movflags',
        '+faststart',
        outputPath,
      ]);

      return outputPath;
    }

    const textFiles = await writeOverlayTextFiles(input.taskId, input.textOverlays);
    const filters = buildDrawTextFilters(input.textOverlays, textFiles).join(',');

    try {
      await runFfmpeg([
        '-y',
        '-i',
        input.generatedVideoUrl,
        '-i',
        input.audioFilePath,
        '-vf',
        filters,
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c:v',
        'libx264',
        '-preset',
        'medium',
        '-crf',
        '18',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        '-movflags',
        '+faststart',
        outputPath,
      ]);
    } finally {
      await fs.remove(path.join(dataDir, `${input.taskId}-overlays`));
    }

    return outputPath;
  }
}
