import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import fs from 'fs-extra';
import axios from 'axios';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import { parse as parseEmojiEntities, toCodePoints } from '@twemoji/parser';
import type { ReferenceTextOverlay } from '../domain/reference-library.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.resolve(__dirname, '../../data/generated-video-work');
const defaultFontFamily = 'DejaVu Sans';
const subtitleFontSizePx = 30; // Will be scaled in ASS
const subtitleOutlineWidthPx = 1.5;
const subtitleBold = true;
const ffmpegTimeoutMs = (() => {
  const parsed = Number(process.env.FFMPEG_TIMEOUT_MS);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }
  return 20 * 60 * 1000; // 20 minutes
})();
const ffmpegPreset = (() => {
  const parsed = String(process.env.FFMPEG_PRESET || '').trim();
  if (parsed) {
    return parsed;
  }
  return 'veryfast';
})();
const ffmpegCrf = (() => {
  const parsed = Number(process.env.FFMPEG_CRF);
  if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 51) {
    return String(Math.floor(parsed));
  }
  return '20';
})();
const postprocessConcurrency = (() => {
  const parsed = Number(process.env.VIDEO_POSTPROCESS_CONCURRENCY);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }
  return 1;
})();
const ffmpegThreads = (() => {
  const parsed = Number(process.env.FFMPEG_THREADS);
  if (Number.isFinite(parsed) && parsed > 0) {
    return String(Math.floor(parsed));
  }
  return '2';
})();
const frameWidthPx = 720;
const frameHeightPx = 1280;
const emojiScale = 1.08;
const emojiFetchTimeoutMs = 15000;
const localTwemojiAssetsDir = path.resolve(process.cwd(), 'node_modules/emoji-datasource-twitter/img/twitter/64');
type LoadedCanvasImage = Awaited<ReturnType<typeof loadImage>>;
const emojiImageCache = new Map<string, Promise<LoadedCanvasImage>>();
let textFontRegistered = false;

function ensureCanvasFonts(fontFamily: string): void {
  if (textFontRegistered) {
    return;
  }

  const candidates = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/local/share/fonts/DejaVuSans.ttf',
    '/Library/Fonts/Arial Unicode.ttf',
    '/Library/Fonts/Arial Unicode MS.ttf',
    '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        GlobalFonts.registerFromPath(candidate, fontFamily);
        textFontRegistered = true;
        return;
      }
    } catch {
      // best-effort
    }
  }
}

interface RunFfmpegOptions {
  timeoutMs?: number;
  label?: string;
}

interface PreparedOverlay {
  overlay: ReferenceTextOverlay;
  text: string;
}

interface OverlayFrame {
  startSeconds: number;
  endSeconds: number;
  imagePath: string;
}

type OverlaySegmentType = 'text' | 'emoji';

interface OverlaySegment {
  type: OverlaySegmentType;
  value: string;
  width: number;
  emojiUrl?: string;
}

interface OverlayLineLayout {
  segments: OverlaySegment[];
  width: number;
}

interface TextRenderStyle {
  fontFamily: string;
  fontSize: number;
  fontColor: string;
  fontWeight: string;
  outlineColor: string;
  outlineWidth: number;
  backgroundColor: string;
  backgroundOpacity: number;
  borderStyle: number;
  verticalMargin: number;
  frameWidthPercent: number;
  frameXPercent: number;
  textAlign: 'left' | 'center' | 'right';
  lineHeight: number;
  boxPaddingX: number;
  boxPaddingY: number;
  boxRadius: number;
}

const defaultTextRenderStyle: TextRenderStyle = {
  fontFamily: defaultFontFamily,
  fontSize: subtitleFontSizePx,
  fontColor: '#FFFFFF',
  fontWeight: subtitleBold ? '700' : '400',
  outlineColor: '#000000',
  outlineWidth: subtitleOutlineWidthPx,
  backgroundColor: '#000000',
  backgroundOpacity: 0.82,
  borderStyle: 1,
  verticalMargin: 40,
  frameWidthPercent: 47,
  frameXPercent: 50,
  textAlign: 'center',
  lineHeight: 1.24,
  boxPaddingX: 18,
  boxPaddingY: 12,
  boxRadius: 10,
};

let activePostprocessJobs = 0;
const postprocessWaitQueue: Array<() => void> = [];

async function withPostprocessSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activePostprocessJobs >= postprocessConcurrency) {
    await new Promise<void>((resolve) => {
      postprocessWaitQueue.push(resolve);
    });
  }

  activePostprocessJobs += 1;
  try {
    return await fn();
  } finally {
    activePostprocessJobs = Math.max(0, activePostprocessJobs - 1);
    const next = postprocessWaitQueue.shift();
    if (next) {
      next();
    }
  }
}

function runFfmpeg(args: string[], options?: RunFfmpegOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeoutMs = options?.timeoutMs ?? ffmpegTimeoutMs;
    const label = options?.label || 'ffmpeg';
    const process = spawn('ffmpeg', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    const startedAt = Date.now();
    let stderr = '';
    let didTimeout = false;

    console.log(`[VideoPostprocessService] ${label}: started (timeout=${timeoutMs}ms)`);

    process.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    const heartbeatTimer = setInterval(() => {
      const elapsedMs = Date.now() - startedAt;
      console.log(`[VideoPostprocessService] ${label}: running ${(elapsedMs / 1000).toFixed(1)}s`);
    }, 30000);

    const timeoutTimer = setTimeout(() => {
      didTimeout = true;
      console.error(`[VideoPostprocessService] ${label}: timeout after ${timeoutMs}ms, killing process`);
      process.kill('SIGKILL');
    }, timeoutMs);

    const clearTimers = () => {
      clearInterval(heartbeatTimer);
      clearTimeout(timeoutTimer);
    };

    process.on('error', (error) => {
      clearTimers();
      reject(new Error(`Не удалось запустить ffmpeg: ${error.message}`));
    });

    process.on('close', (code) => {
      clearTimers();
      const elapsedMs = Date.now() - startedAt;

      if (didTimeout) {
        reject(new Error(`ffmpeg timed out after ${timeoutMs}ms (${label})`));
        return;
      }

      if (code === 0) {
        console.log(`[VideoPostprocessService] ${label}: completed in ${(elapsedMs / 1000).toFixed(1)}s`);
        resolve();
        return;
      }

      reject(new Error(`ffmpeg завершился с ошибкой (${label}): ${stderr.trim() || `code ${code}`}`));
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

function sanitizeAssFontName(value: string): string {
  const cleaned = value.replace(/[,\r\n]+/g, ' ').trim();
  return cleaned || defaultTextRenderStyle.fontFamily;
}

function normalizeEmojiPresentation(value: string): string {
  // libass in ffmpeg typically cannot render colored emoji sequences.
  // Removing emoji variation selectors improves fallback to monochrome glyph fonts.
  return value.replace(/[\uFE0E\uFE0F]/g, '');
}

function hasEmojiGlyphs(value: string): boolean {
  return /\p{Extended_Pictographic}/u.test(value);
}

function escapeAssDialogueText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r/g, '')
    .replace(/\n/g, '\\N');
}

function toAssAlignment(textAlign: TextRenderStyle['textAlign']): number {
  if (textAlign === 'left') {
    return 1;
  }
  if (textAlign === 'right') {
    return 3;
  }
  return 2;
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
  const frameWidthPercent = Math.round(clamp(toFiniteNumber(source.frameWidthPercent) ?? defaultTextRenderStyle.frameWidthPercent, 20, 100));
  const frameXPercent = Math.round(clamp(toFiniteNumber(source.frameXPercent) ?? defaultTextRenderStyle.frameXPercent, 0, 100));
  const lineHeight = clamp(toFiniteNumber(source.lineHeight) ?? defaultTextRenderStyle.lineHeight, 0.8, 2);
  const backgroundOpacity = clamp(toFiniteNumber(source.backgroundOpacity) ?? defaultTextRenderStyle.backgroundOpacity, 0, 1);
  const boxPaddingX = Math.round(clamp(toFiniteNumber(source.boxPaddingX) ?? defaultTextRenderStyle.boxPaddingX, 0, 120));
  const boxPaddingY = Math.round(clamp(toFiniteNumber(source.boxPaddingY) ?? defaultTextRenderStyle.boxPaddingY, 0, 80));
  const boxRadius = Math.round(clamp(toFiniteNumber(source.boxRadius) ?? defaultTextRenderStyle.boxRadius, 0, 120));
  const borderStyleRaw = toFiniteNumber(source.borderStyle);
  const borderStyle = borderStyleRaw === 3 ? 3 : 1;
  const textAlignRaw = typeof source.textAlign === 'string' ? source.textAlign.trim().toLowerCase() : '';
  const textAlign: TextRenderStyle['textAlign'] =
    textAlignRaw === 'left' || textAlignRaw === 'right' || textAlignRaw === 'center'
      ? textAlignRaw
      : defaultTextRenderStyle.textAlign;

  return {
    fontFamily: sanitizeAssFontName(fontFamily),
    fontSize,
    fontColor: normalizeHexColor(source.fontColor, defaultTextRenderStyle.fontColor),
    fontWeight,
    outlineColor: normalizeHexColor(source.outlineColor, defaultTextRenderStyle.outlineColor),
    outlineWidth,
    backgroundColor: normalizeHexColor(source.backgroundColor, defaultTextRenderStyle.backgroundColor),
    backgroundOpacity,
    borderStyle,
    verticalMargin,
    frameWidthPercent,
    frameXPercent,
    textAlign,
    lineHeight,
    boxPaddingX,
    boxPaddingY,
    boxRadius,
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
  const normalizedText = text.normalize('NFC');
  const normalizedMaxChars = Math.max(10, maxCharsPerLine);
  const sourceLines = normalizedText.replace(/\r/g, '').split('\n');
  if (sourceLines.length > 1) {
    return sourceLines.map((line) => line.trim()).join('\n');
  }

  const wrappedLines = sourceLines.flatMap((line) => wrapLineByWords(line, normalizedMaxChars));
  return wrappedLines.join('\n');
}

function estimateSubtitleMaxCharsPerLine(style: TextRenderStyle): number {
  const frameWidthPx = Math.floor((720 * style.frameWidthPercent) / 100);
  const horizontalPadding = style.borderStyle === 3 ? style.boxPaddingX * 2 : 0;
  const contentWidthPx = Math.max(80, frameWidthPx - horizontalPadding);
  const estimated = Math.floor(contentWidthPx / (style.fontSize * 0.56));
  return Math.round(clamp(estimated, 8, 80));
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
  const frameWidthPx = Math.floor((720 * style.frameWidthPercent) / 100);
  const centerXPx = Math.floor((720 * style.frameXPercent) / 100);
  const halfFrame = Math.floor(frameWidthPx / 2);
  const marginL = Math.round(clamp(centerXPx - halfFrame, 0, 719));
  const marginR = Math.round(clamp(720 - (centerXPx + halfFrame), 0, 719));
  const alignment = toAssAlignment(style.textAlign);

  const toAssColor = (hex: string, alpha = 0) => {
    if (!hex || !hex.startsWith('#')) return '&H00FFFFFF&';
    const r = hex.slice(1, 3);
    const g = hex.slice(3, 5);
    const b = hex.slice(5, 7);
    const alphaHex = Math.round(clamp(alpha, 0, 1) * 255).toString(16).toUpperCase().padStart(2, '0');
    return `&H${alphaHex}${b}${g}${r}&`;
  };

  const primaryColor = toAssColor(style.fontColor);
  const outlineColor = toAssColor(style.outlineColor);
  const backColor = toAssColor(style.backgroundColor, 1 - style.backgroundOpacity);
  const isBold = style.fontWeight === 'bold' || parseInt(style.fontWeight, 10) >= 700;

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 720
PlayResY: 1280
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${style.fontFamily},${style.fontSize},${primaryColor},&H000000FF,${outlineColor},${backColor},${isBold ? -1 : 0},0,0,0,100,100,0,0,${style.borderStyle},${style.outlineWidth},0.5,${alignment},${marginL},${marginR},${marginV},1
`;

  const events = `
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const lines = overlays.map((prepared) => {
    const { overlay, text } = prepared;
    const start = formatSecondsToAssTime(overlay.startSeconds);
    const end = formatSecondsToAssTime(overlay.endSeconds);

    const escapedText = escapeAssDialogueText(normalizeEmojiPresentation(text));
    
    return `Dialogue: 0,${start},${end},Default,,0,0,0,,${escapedText}`;
  });

  return header + events + lines.join('\n');
}

function prepareOverlayForRender(overlay: ReferenceTextOverlay, style: TextRenderStyle): PreparedOverlay {
  const maxCharsPerLine = estimateSubtitleMaxCharsPerLine(style);
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

function buildOverlayFilterGraph(frames: OverlayFrame[]): { graph: string; finalLabel: string } {
  let currentLabel = '0:v';
  const chains: string[] = [];

  frames.forEach((frame, index) => {
    const inputLabel = `${index + 2}:v`;
    const outputLabel = `v${index + 1}`;
    const start = Math.max(0, frame.startSeconds);
    const end = Math.max(start + 0.01, frame.endSeconds);
    chains.push(
      `[${currentLabel}][${inputLabel}]overlay=x=0:y=0:enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'[${outputLabel}]`
    );
    currentLabel = outputLabel;
  });

  return {
    graph: chains.join(';'),
    finalLabel: currentLabel,
  };
}

function toRgbaColor(hex: string, alpha: number): string {
  const normalized = normalizeHexColor(hex, '#000000');
  const r = Number.parseInt(normalized.slice(1, 3), 16);
  const g = Number.parseInt(normalized.slice(3, 5), 16);
  const b = Number.parseInt(normalized.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${clamp(alpha, 0, 1)})`;
}

function buildCanvasFont(style: TextRenderStyle): string {
  return `${style.fontWeight} ${style.fontSize}px "${style.fontFamily}", "DejaVu Sans", sans-serif`;
}

function buildLineLayout(
  line: string,
  measureText: (value: string) => number,
  style: TextRenderStyle
): OverlayLineLayout {
  if (!line) {
    return { segments: [], width: 0 };
  }

  const emojiEntities = parseEmojiEntities(line, { assetType: 'png' });
  if (!emojiEntities.length) {
    return {
      segments: [{ type: 'text', value: line, width: measureText(line) }],
      width: measureText(line),
    };
  }

  const segments: OverlaySegment[] = [];
  let totalWidth = 0;
  let cursor = 0;

  for (const entity of emojiEntities) {
    const [start, end] = entity.indices;
    if (start > cursor) {
      const plainText = line.slice(cursor, start);
      const textWidth = measureText(plainText);
      segments.push({ type: 'text', value: plainText, width: textWidth });
      totalWidth += textWidth;
    }

    const emojiToken = line.slice(start, end);
    const emojiWidth = style.fontSize * emojiScale;
    segments.push({
      type: 'emoji',
      value: emojiToken,
      width: emojiWidth,
      emojiUrl: entity.url,
    });
    totalWidth += emojiWidth;
    cursor = end;
  }

  if (cursor < line.length) {
    const tailText = line.slice(cursor);
    const tailWidth = measureText(tailText);
    segments.push({ type: 'text', value: tailText, width: tailWidth });
    totalWidth += tailWidth;
  }

  return { segments, width: totalWidth };
}

function resolveLocalTwemojiPath(emojiToken: string, emojiUrl: string): string {
  if (emojiUrl) {
    try {
      const parsed = new URL(emojiUrl);
      const baseName = path.basename(parsed.pathname).replace(/\.svg$/i, '.png');
      if (baseName) {
        return path.join(localTwemojiAssetsDir, baseName);
      }
    } catch {
      // no-op
    }
  }

  const codePoints = toCodePoints(emojiToken);
  if (!Array.isArray(codePoints) || !codePoints.length) {
    return '';
  }

  return path.join(localTwemojiAssetsDir, `${codePoints.join('-')}.png`);
}

async function getEmojiImage(emojiToken: string, url: string): Promise<LoadedCanvasImage | null> {
  if (!emojiToken && !url) {
    return null;
  }

  const localAssetPath = resolveLocalTwemojiPath(emojiToken, url);
  if (localAssetPath && await fs.pathExists(localAssetPath)) {
    const localCacheKey = `file:${localAssetPath}`;
    const localCached = emojiImageCache.get(localCacheKey);
    if (localCached) {
      return localCached.catch(() => null);
    }

    const localPromise = fs.readFile(localAssetPath).then((buffer) => loadImage(buffer));
    emojiImageCache.set(localCacheKey, localPromise);
    try {
      return await localPromise;
    } catch {
      emojiImageCache.delete(localCacheKey);
      // fallback to remote branch
    }
  }

  const cacheKey = url || emojiToken;
  const cached = emojiImageCache.get(cacheKey);
  if (cached) {
    return cached.catch(() => null);
  }

  const nextPromise = (async () => {
    if (!url) {
      throw new Error('emoji url is missing');
    }

    const response = await axios.get<ArrayBuffer>(url, {
      responseType: 'arraybuffer',
      timeout: emojiFetchTimeoutMs,
      maxContentLength: 1024 * 1024,
      maxBodyLength: 1024 * 1024,
    });
    return loadImage(Buffer.from(response.data));
  })();

  emojiImageCache.set(cacheKey, nextPromise);

  try {
    return await nextPromise;
  } catch (error) {
    emojiImageCache.delete(cacheKey);
    return null;
  }
}

function buildTextFrameGeometry(style: TextRenderStyle): {
  left: number;
  width: number;
  bottomMargin: number;
} {
  const frameWidth = Math.max(120, Math.floor((style.frameWidthPercent / 100) * frameWidthPx));
  const centerX = Math.floor((style.frameXPercent / 100) * frameWidthPx);
  const left = Math.round(clamp(centerX - Math.floor(frameWidth / 2), 0, frameWidthPx - frameWidth));
  const bottomMargin = Math.floor(style.verticalMargin * 2.5);
  return { left, width: frameWidth, bottomMargin };
}

function drawRoundRect(
  ctx: any,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  const safeRadius = clamp(radius, 0, Math.min(width, height) / 2);
  ctx.beginPath();
  ctx.moveTo(x + safeRadius, y);
  ctx.arcTo(x + width, y, x + width, y + height, safeRadius);
  ctx.arcTo(x + width, y + height, x, y + height, safeRadius);
  ctx.arcTo(x, y + height, x, y, safeRadius);
  ctx.arcTo(x, y, x + width, y, safeRadius);
  ctx.closePath();
}

async function renderOverlayFramesWithCanvas(taskId: string, overlays: PreparedOverlay[], style: TextRenderStyle): Promise<OverlayFrame[]> {
  const overlayDir = path.join(dataDir, `${taskId}-overlays`);
  const framesDir = path.join(overlayDir, 'frames');
  await fs.ensureDir(framesDir);
  ensureCanvasFonts(style.fontFamily);

  const frames: OverlayFrame[] = [];
  const lineHeightPx = Math.max(style.fontSize * style.lineHeight, style.fontSize + 2);
  const textFrame = buildTextFrameGeometry(style);

  for (const [index, item] of overlays.entries()) {
    const startSeconds = item.overlay.startSeconds;
    const endSeconds = item.overlay.endSeconds;
    if (!(endSeconds > startSeconds)) {
      continue;
    }

    const canvas = createCanvas(frameWidthPx, frameHeightPx);
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, frameWidthPx, frameHeightPx);
    ctx.font = buildCanvasFont(style);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = style.fontColor;
    ctx.strokeStyle = style.outlineColor;
    ctx.lineWidth = Math.max(0.5, style.outlineWidth * 1.2);

    const lines = item.text.split('\n');
    const lineLayouts = lines.map((line) => buildLineLayout(line, (value) => ctx.measureText(value).width, style));
    const contentWidth = lineLayouts.reduce((max, layout) => Math.max(max, layout.width), 0);
    const textAreaWidth = style.borderStyle === 3
      ? Math.max(40, textFrame.width - style.boxPaddingX * 2)
      : textFrame.width;
    const overlayWidth = Math.min(textAreaWidth, Math.max(1, contentWidth));
    const textHeight = Math.max(lineHeightPx, lineLayouts.length * lineHeightPx);
    const boxHeight = style.borderStyle === 3 ? textHeight + style.boxPaddingY * 2 : textHeight;
    const top = Math.round(clamp(frameHeightPx - textFrame.bottomMargin - boxHeight, 0, frameHeightPx - 1));
    const textTop = style.borderStyle === 3 ? top + style.boxPaddingY : top;
    const textAreaLeft = style.borderStyle === 3 ? textFrame.left + style.boxPaddingX : textFrame.left;

    if (style.borderStyle === 3) {
      const boxWidth = Math.min(
        textFrame.width,
        Math.max(style.boxPaddingX * 2 + overlayWidth, Math.min(textFrame.width, 120))
      );
      let boxLeft = textFrame.left;
      if (style.textAlign === 'center') {
        boxLeft = textFrame.left + Math.round((textFrame.width - boxWidth) / 2);
      } else if (style.textAlign === 'right') {
        boxLeft = textFrame.left + textFrame.width - boxWidth;
      }
      ctx.fillStyle = toRgbaColor(style.backgroundColor, style.backgroundOpacity);
      drawRoundRect(ctx, boxLeft, top, boxWidth, boxHeight, style.boxRadius);
      ctx.fill();
      ctx.fillStyle = style.fontColor;
    }

    for (const [lineIndex, layout] of lineLayouts.entries()) {
      const baselineY = textTop + style.fontSize + (lineIndex * lineHeightPx);
      let cursorX = textAreaLeft;
      if (style.textAlign === 'center') {
        cursorX = textAreaLeft + Math.max(0, (textAreaWidth - layout.width) / 2);
      } else if (style.textAlign === 'right') {
        cursorX = textAreaLeft + Math.max(0, textAreaWidth - layout.width);
      }

      for (const segment of layout.segments) {
        if (segment.type === 'text') {
          if (segment.value && style.borderStyle !== 3) {
            ctx.strokeText(segment.value, cursorX, baselineY);
          }
          if (segment.value) {
            ctx.fillText(segment.value, cursorX, baselineY);
          }
          cursorX += segment.width;
          continue;
        }

        const emojiUrl = segment.emojiUrl || '';
        const emojiImage = await getEmojiImage(segment.value, emojiUrl);
        const emojiSize = style.fontSize * emojiScale;
        const emojiY = baselineY - (style.fontSize * 0.9);
        if (emojiImage) {
          ctx.drawImage(emojiImage, cursorX, emojiY, emojiSize, emojiSize);
        } else if (segment.value) {
          // Fallback for network/CDN hiccups.
          ctx.fillText(segment.value, cursorX, baselineY);
        }
        cursorX += segment.width;
      }
    }

    const imagePath = path.join(framesDir, `overlay-${String(index + 1).padStart(3, '0')}.png`);
    await fs.writeFile(imagePath, canvas.toBuffer('image/png'));
    frames.push({
      startSeconds,
      endSeconds,
      imagePath,
    });
  }

  return frames;
}

export class VideoPostprocessService {
  public static async applyAudioTrack(input: {
    taskId: string;
    generatedVideoUrl: string;
    audioFilePath: string;
    trimVideoToAudio?: boolean;
    textOverlays?: ReferenceTextOverlay[];
    textStyle?: unknown;
  }): Promise<string> {
    await fs.ensureDir(dataDir);
    return withPostprocessSlot(async () => {
      const outputPath = path.join(dataDir, `${input.taskId}.mp4`);
      const shouldTrimVideoToAudio = Boolean(input.trimVideoToAudio);
      const audioMode = shouldTrimVideoToAudio ? 'trim_video_to_audio' : 'loop_audio_to_video';
      console.log(
        `[VideoPostprocessService] Task ${input.taskId}: start postprocess (mode=${audioMode}, overlays=${input.textOverlays?.length || 0}, preset=${ffmpegPreset}, crf=${ffmpegCrf}, threads=${ffmpegThreads}, queue_limit=${postprocessConcurrency})`
      );

      if (!input.textOverlays?.length) {
        const ffmpegArgs = [
          '-y',
          '-i',
          input.generatedVideoUrl,
        ];

        if (!shouldTrimVideoToAudio) {
          ffmpegArgs.push('-stream_loop', '-1');
        }

        ffmpegArgs.push(
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
        );

        await runFfmpeg(ffmpegArgs, {
          label: `task ${input.taskId} ffmpeg (no-overlays)`,
        });

        console.log(`[VideoPostprocessService] Task ${input.taskId}: postprocess complete (no overlays).`);

        return outputPath;
      }

      const resolvedTextStyle = resolveTextStyle(input.textStyle);
      const preparedOverlays = input.textOverlays.map((overlay) => prepareOverlayForRender(overlay, resolvedTextStyle));
      const containsEmoji = preparedOverlays.some((item) => hasEmojiGlyphs(item.text));
      const overlayWorkDir = path.join(dataDir, `${input.taskId}-overlays`);

      try {
        if (containsEmoji) {
          try {
            console.log(`[VideoPostprocessService] Task ${input.taskId}: emoji detected, rendering overlays via Canvas+Twemoji...`);
            const overlayFrames = await renderOverlayFramesWithCanvas(input.taskId, preparedOverlays, resolvedTextStyle);
            if (overlayFrames.length > 0) {
              console.log(
                `[VideoPostprocessService] Task ${input.taskId}: rendered ${overlayFrames.length} overlay frame(s), running ffmpeg overlay graph...`
              );
              const { graph, finalLabel } = buildOverlayFilterGraph(overlayFrames);
              const ffmpegArgs = [
                '-y',
                '-i',
                input.generatedVideoUrl,
              ];

              if (!shouldTrimVideoToAudio) {
                ffmpegArgs.push('-stream_loop', '-1');
              }

              ffmpegArgs.push(
                '-i',
                input.audioFilePath,
              );

              overlayFrames.forEach((frame) => {
                ffmpegArgs.push('-loop', '1', '-i', frame.imagePath);
              });

              ffmpegArgs.push(
                '-filter_complex',
                graph,
                '-map',
                `[${finalLabel}]`,
                '-map',
                '1:a:0',
                '-c:v',
                'libx264',
                '-threads',
                ffmpegThreads,
                '-preset',
                ffmpegPreset,
                '-crf',
                ffmpegCrf,
                '-pix_fmt',
                'yuv420p',
                '-c:a',
                'aac',
                '-shortest',
                '-movflags',
                '+faststart',
                outputPath
              );

              await runFfmpeg(ffmpegArgs, {
                label: `task ${input.taskId} ffmpeg (emoji-canvas-overlays)`,
              });
              console.log(`[VideoPostprocessService] Task ${input.taskId}: postprocess complete (emoji canvas overlays).`);
              return outputPath;
            }

            console.warn(`[VideoPostprocessService] Task ${input.taskId}: Canvas emoji renderer produced 0 overlay frames, fallback to ASS.`);
          } catch (error: any) {
            console.warn('[VideoPostprocessService] Canvas emoji renderer failed, fallback to ASS:', error?.message || error);
          }
        } else {
          console.log(`[VideoPostprocessService] Task ${input.taskId}: no emoji in overlays, using ASS renderer.`);
        }

        const assFilePath = await writeAssFile(input.taskId, preparedOverlays, resolvedTextStyle);
        const relativeAssPath = path.relative(process.cwd(), assFilePath);
        const filter = `subtitles='${escapeFilterValue(relativeAssPath)}'`;
        console.log(`[VideoPostprocessService] Task ${input.taskId}: running ffmpeg with ASS subtitles...`);

        await runFfmpeg([
          '-y',
          '-i',
          input.generatedVideoUrl,
          ...(!shouldTrimVideoToAudio ? ['-stream_loop', '-1'] : []),
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
          '-threads',
          ffmpegThreads,
          '-preset',
          ffmpegPreset,
          '-crf',
          ffmpegCrf,
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-shortest',
          '-movflags',
          '+faststart',
          outputPath,
        ], {
          label: `task ${input.taskId} ffmpeg (ass-overlays)`,
        });
        console.log(`[VideoPostprocessService] Task ${input.taskId}: postprocess complete (ASS overlays).`);
      } finally {
        await fs.remove(overlayWorkDir);
      }

      return outputPath;
    });
  }
}
