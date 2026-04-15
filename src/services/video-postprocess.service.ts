import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import fs from 'fs-extra';
import type { ReferenceTextOverlay } from '../domain/reference-library.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.resolve(__dirname, '../../data/generated-video-work');
const defaultFontFamily = 'Arial';
const subtitleFrameWidthPercent = 0.86;
const subtitleHorizontalPaddingPx = 141;
const subtitleFontSizePx = 30; // Will be scaled in ASS
const subtitleOutlineWidthPx = 1.5;
const subtitleBold = true;

interface PreparedOverlay {
  overlay: ReferenceTextOverlay;
  text: string;
}

interface TextRenderStyle {
  fontFamily: string;
  fontSize: number;
  fontColor: string;
  fontWeight: string;
  outlineColor: string;
  outlineWidth: number;
  backgroundColor: string;
  borderStyle: number;
  verticalMargin: number;
}

const defaultTextRenderStyle: TextRenderStyle = {
  fontFamily: defaultFontFamily,
  fontSize: subtitleFontSizePx,
  fontColor: '#FFFFFF',
  fontWeight: subtitleBold ? '700' : '400',
  outlineColor: '#000000',
  outlineWidth: subtitleOutlineWidthPx,
  backgroundColor: '#000000',
  borderStyle: 1,
  verticalMargin: 40,
};

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

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function normalizeHexColor(value: unknown, fallback: string): string {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (/^#[0-9A-F]{6}$/.test(normalized)) {
    return normalized;
  }
  return fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function resolveTextStyle(style: unknown): TextRenderStyle {
  const source = style && typeof style === 'object' ? (style as Record<string, unknown>) : {};
  const fontFamily = typeof source.fontFamily === 'string' && source.fontFamily.trim()
    ? source.fontFamily.trim()
    : defaultTextRenderStyle.fontFamily;
  const fontWeight = typeof source.fontWeight === 'string' && /^(normal|bold|[1-9]00)$/.test(source.fontWeight.trim())
    ? source.fontWeight.trim()
    : defaultTextRenderStyle.fontWeight;
  const fontSize = Math.round(clamp(toFiniteNumber(source.fontSize) ?? defaultTextRenderStyle.fontSize, 10, 120));
  const outlineWidth = clamp(toFiniteNumber(source.outlineWidth) ?? defaultTextRenderStyle.outlineWidth, 0, 12);
  const verticalMargin = Math.round(clamp(toFiniteNumber(source.verticalMargin) ?? defaultTextRenderStyle.verticalMargin, 0, 500));
  const borderStyleRaw = toFiniteNumber(source.borderStyle);
  const borderStyle = borderStyleRaw === 3 ? 3 : 1;

  return {
    fontFamily,
    fontSize,
    fontColor: normalizeHexColor(source.fontColor, defaultTextRenderStyle.fontColor),
    fontWeight,
    outlineColor: normalizeHexColor(source.outlineColor, defaultTextRenderStyle.outlineColor),
    outlineWidth,
    backgroundColor: normalizeHexColor(source.backgroundColor, defaultTextRenderStyle.backgroundColor),
    borderStyle,
    verticalMargin,
  };
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
  if (sourceLines.length > 1) {
    return sourceLines.map((line) => line.trim()).join('\n');
  }

  const wrappedLines = sourceLines.flatMap((line) => wrapLineByWords(line, normalizedMaxChars));
  return wrappedLines.join('\n');
}

function estimateSubtitleMaxCharsPerLine(): number {
  // 720px baseline for portrait content. Keeps subtitle wrap close to real output sizes.
  const frameWidthPx = 720 * subtitleFrameWidthPercent;
  const contentWidthPx = Math.max(220, frameWidthPx - (subtitleHorizontalPaddingPx * 2));
  const estimated = Math.floor(contentWidthPx / (subtitleFontSizePx * 0.56));
  return clamp(estimated, 12, 42);
}

function formatSecondsToAssTime(seconds: number): string {
  const date = new Date(seconds * 1000);
  const h = Math.floor(seconds / 3600);
  const m = date.getUTCMinutes().toString().padStart(2, '0');
  const s = date.getUTCSeconds().toString().padStart(2, '0');
  const ms = Math.floor((seconds % 1) * 100).toString().padStart(2, '0');
  return `${h}:${m}:${s}.${ms}`;
}

function generateAssFileContent(overlays: PreparedOverlay[], style: TextRenderStyle): string {
  // Styles and configuration for the ASS file.
  // MarginV controls the vertical distance from the bottom.
  const marginV = Math.floor(style.verticalMargin * 2.5); // Scaled for 720x1280

  const toAssColor = (hex: string) => {
    if (!hex || !hex.startsWith('#')) return '&H00FFFFFF&';
    const r = hex.slice(1, 3);
    const g = hex.slice(3, 5);
    const b = hex.slice(5, 7);
    return `&H00${b}${g}${r}&`;
  };

  const primaryColor = toAssColor(style.fontColor);
  const outlineColor = toAssColor(style.outlineColor);
  const backColor = toAssColor(style.backgroundColor);
  const isBold = style.fontWeight === 'bold' || parseInt(style.fontWeight, 10) >= 700;

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 720
PlayResY: 1280
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${style.fontFamily},${style.fontSize},${primaryColor},&H000000FF,${outlineColor},${backColor},${isBold ? -1 : 0},0,0,0,100,100,0,0,${style.borderStyle},${style.outlineWidth},0.5,2,20,20,${marginV},1
`;

  const events = `
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const lines = overlays.map((prepared) => {
    const { overlay, text } = prepared;
    const start = formatSecondsToAssTime(overlay.startSeconds);
    const end = formatSecondsToAssTime(overlay.endSeconds);
    
    // Convert newlines to \N for ASS
    const escapedText = text.replace(/\n/g, '\\N');
    
    return `Dialogue: 0,${start},${end},Default,,0,0,0,,${escapedText}`;
  });

  return header + events + lines.join('\n');
}

function prepareOverlayForRender(overlay: ReferenceTextOverlay): PreparedOverlay {
  const maxCharsPerLine = estimateSubtitleMaxCharsPerLine();
  const text = wrapOverlayText(overlay.text, maxCharsPerLine);

  return {
    overlay,
    text,
  };
}

async function writeAssFile(taskId: string, overlays: PreparedOverlay[], style: TextRenderStyle): Promise<string> {
  const overlayDir = path.join(dataDir, `${taskId}-overlays`);
  await fs.ensureDir(overlayDir);
  
  const assContent = generateAssFileContent(overlays, style);
  const filePath = path.join(overlayDir, 'subtitles.ass');
  await fs.writeFile(filePath, assContent, 'utf8');
  return filePath;
}

export class VideoPostprocessService {
  public static async applyAudioTrack(input: {
    taskId: string;
    generatedVideoUrl: string;
    audioFilePath: string;
    textOverlays?: ReferenceTextOverlay[];
    textStyle?: unknown;
  }): Promise<string> {
    await fs.ensureDir(dataDir);

    const outputPath = path.join(dataDir, `${input.taskId}.mp4`);

    if (!input.textOverlays?.length) {
      await runFfmpeg([
        '-y',
        '-i',
        input.generatedVideoUrl,
        '-stream_loop',
        '-1',
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
    const resolvedTextStyle = resolveTextStyle(input.textStyle);
    const assFilePath = await writeAssFile(input.taskId, preparedOverlays, resolvedTextStyle);
    
    // FFmpeg subtitles filter on macOS/Darwin often needs carefully escaped paths.
    // We use a relative path or an escaped absolute path.
    const relativeAssPath = path.relative(process.cwd(), assFilePath);
    const filter = `subtitles='${escapeFilterValue(relativeAssPath)}'`;

    try {
      await runFfmpeg([
        '-y',
        '-i',
        input.generatedVideoUrl,
        '-stream_loop',
        '-1',
        '-i',
        input.audioFilePath,
        '-vf',
        filter,
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
