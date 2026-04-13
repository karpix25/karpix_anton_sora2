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
const overlayFontScale = 0.78;
const overlayTopYOffsetByFont = 0.65;
const minOverlayFontSizePercent = 0.018;
const maxOverlayFontSizePercent = 0.07;
const defaultLineSpacing = 3;

interface PreparedOverlay {
  overlay: ReferenceTextOverlay;
  text: string;
  xPercent: number;
  yPercent: number;
  fontSizePercent: number;
}

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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isCenterAnchor(anchor: ReferenceTextOverlay['anchor']): boolean {
  return anchor === 'top-center'
    || anchor === 'center'
    || anchor === 'bottom-center';
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

function padLinesForCenterAlignment(text: string): string {
  const lines = text.split('\n');
  if (lines.length <= 1) {
    return text;
  }

  const trimmedLines = lines.map((line) => line.trim());
  const maxLength = Math.max(...trimmedLines.map((line) => Array.from(line).length));
  if (maxLength <= 0) {
    return text;
  }

  return trimmedLines
    .map((line) => {
      const missing = Math.max(0, maxLength - Array.from(line).length);
      const leftPadding = Math.floor(missing / 2);
      return `${' '.repeat(leftPadding)}${line}`;
    })
    .join('\n');
}

function wrapOverlayText(text: string, maxCharsPerLine: number): string {
  const normalizedMaxChars = Math.max(10, maxCharsPerLine);
  const sourceLines = text.replace(/\r/g, '').split('\n');
  if (sourceLines.length > 1) {
    return sourceLines.map((line) => line.trim()).join('\n');
  }

  const wrappedLines = sourceLines.flatMap((line) => wrapLineByWords(line, normalizedMaxChars));
  return wrappedLines.join('\n');
}

function estimateMaxCharsPerLine(fontSizePercent: number, anchor: ReferenceTextOverlay['anchor']): number {
  const normalizedSize = Math.max(0.02, fontSizePercent);
  const base = isCenterAnchor(anchor) ? 25 : 30;
  const estimated = Math.round(base * (0.04 / normalizedSize));
  const min = isCenterAnchor(anchor) ? 12 : 14;
  const max = isCenterAnchor(anchor) ? 36 : 44;
  return Math.max(min, Math.min(max, estimated));
}

function getAnchorExpressions(input: {
  anchor: ReferenceTextOverlay['anchor'];
  xPercent: number;
  yPercent: number;
}): { x: string; y: string } {
  const xBase = `w*${input.xPercent.toFixed(4)}`;
  const yBase = `h*${input.yPercent.toFixed(4)}`;

  switch (input.anchor) {
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

function getBoundedAnchorExpressions(input: {
  anchor: ReferenceTextOverlay['anchor'];
  xPercent: number;
  yPercent: number;
}): { x: string; y: string } {
  const { x, y } = getAnchorExpressions(input);
  const margin = `h*${overlaySafeMarginPercent.toFixed(4)}`;

  return {
    x: `max(${margin},min(${x},w-text_w-${margin}))`,
    y: `max(${margin},min(${y},h-text_h-${margin}))`,
  };
}

function prepareOverlayForRender(overlay: ReferenceTextOverlay): PreparedOverlay {
  const fontSizePercent = clamp(
    Math.max(minOverlayFontSizePercent, overlay.fontSizePercent) * overlayFontScale,
    minOverlayFontSizePercent,
    maxOverlayFontSizePercent,
  );
  const xPercent = clamp(overlay.xPercent, 0, 1);
  let yPercent = clamp(overlay.yPercent, 0, 1);

  if (overlay.anchor.startsWith('top')) {
    yPercent = clamp(yPercent - fontSizePercent * overlayTopYOffsetByFont, overlaySafeMarginPercent, 1);
  }

  const maxCharsPerLine = estimateMaxCharsPerLine(fontSizePercent, overlay.anchor);
  let text = wrapOverlayText(overlay.text, maxCharsPerLine);
  if (isCenterAnchor(overlay.anchor)) {
    text = padLinesForCenterAlignment(text);
  }

  return {
    overlay,
    text,
    xPercent,
    yPercent,
    fontSizePercent,
  };
}

async function writeOverlayTextFiles(taskId: string, overlays: PreparedOverlay[]): Promise<string[]> {
  const overlayDir = path.join(dataDir, `${taskId}-overlays`);
  await fs.ensureDir(overlayDir);

  const files: string[] = [];
  for (let index = 0; index < overlays.length; index += 1) {
    const overlay = overlays[index];
    if (!overlay) {
      continue;
    }

    const filePath = path.join(overlayDir, `${index + 1}.txt`);
    await fs.writeFile(filePath, overlay.text, 'utf8');
    files.push(filePath);
  }

  return files;
}

function buildDrawTextFilters(overlays: PreparedOverlay[], textFiles: string[]): string[] {
  return overlays.map((prepared, index) => {
    const { overlay } = prepared;
    const textFile = textFiles[index];
    const { x, y } = getBoundedAnchorExpressions({
      anchor: overlay.anchor,
      xPercent: prepared.xPercent,
      yPercent: prepared.yPercent,
    });
    const safeX = escapeDrawtextExpression(x);
    const safeY = escapeDrawtextExpression(y);
    const textColor = normalizeFfmpegColor(overlay.textColor, '0xFFFFFF');
    const boxColor = `${normalizeFfmpegColor(overlay.boxColor, '0x000000')}@${Math.max(0, Math.min(1, overlay.boxOpacity)).toFixed(2)}`;
    const params = [
      `font='${escapeFilterValue(defaultFontFamily)}'`,
      `textfile='${escapeFilterValue(textFile || '')}'`,
      `reload=1`,
      `fontsize=h*${prepared.fontSizePercent.toFixed(4)}`,
      `fontcolor=${textColor}`,
      `x=${safeX}`,
      `y=${safeY}`,
      `fix_bounds=1`,
      `box=${overlay.box ? 1 : 0}`,
      `boxcolor=${boxColor}`,
      `boxborderw=12`,
      `line_spacing=${defaultLineSpacing}`,
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

    const preparedOverlays = input.textOverlays.map((overlay) => prepareOverlayForRender(overlay));
    const textFiles = await writeOverlayTextFiles(input.taskId, preparedOverlays);
    const filters = buildDrawTextFilters(preparedOverlays, textFiles).join(',');

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
