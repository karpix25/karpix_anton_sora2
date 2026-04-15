import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import fs from 'fs-extra';
import puppeteer from 'puppeteer-core';
import type { ReferenceTextOverlay } from '../domain/reference-library.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.resolve(__dirname, '../../data/generated-video-work');
const defaultFontFamily = 'DejaVu Sans';
const subtitleFontSizePx = 30; // Will be scaled in ASS
const subtitleOutlineWidthPx = 1.5;
const subtitleBold = true;

interface PreparedOverlay {
  overlay: ReferenceTextOverlay;
  text: string;
}

interface OverlayFrame {
  startSeconds: number;
  endSeconds: number;
  imagePath: string;
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

function sanitizeAssFontName(value: string): string {
  const cleaned = value.replace(/[,\r\n]+/g, ' ').trim();
  return cleaned || defaultTextRenderStyle.fontFamily;
}

function normalizeEmojiPresentation(value: string): string {
  // libass in ffmpeg typically cannot render colored emoji sequences.
  // Removing emoji variation selectors improves fallback to monochrome glyph fonts.
  return value.replace(/[\uFE0E\uFE0F]/g, '');
}

function escapeAssDialogueText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r/g, '')
    .replace(/\n/g, '\\N');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeCssString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function toGoogleFontFamilyParam(fontFamily: string): string {
  return fontFamily
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => encodeURIComponent(token))
    .join('+');
}

function toRgba(hex: string, alpha: number): string {
  const normalized = normalizeHexColor(hex, '#000000');
  const r = Number.parseInt(normalized.slice(1, 3), 16);
  const g = Number.parseInt(normalized.slice(3, 5), 16);
  const b = Number.parseInt(normalized.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${clamp(alpha, 0, 1)})`;
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

function resolveChromiumExecutablePath(): string {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROMIUM_PATH,
    process.env.CHROMIUM_BIN,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].filter((value): value is string => Boolean(value && value.trim()));

  const found = candidates.find((filePath) => existsSync(filePath));
  if (!found) {
    throw new Error('Chromium executable is not available. Set PUPPETEER_EXECUTABLE_PATH or install chromium.');
  }

  return found;
}

function buildOverlayFrameHtml(text: string, style: TextRenderStyle): string {
  const frameWidth = 720;
  const frameHeight = 1280;
  const textFrameWidthPx = Math.max(120, Math.floor((style.frameWidthPercent / 100) * frameWidth));
  const marginBottomPx = Math.floor(style.verticalMargin * 2.5);
  const fontFamily = escapeCssString(style.fontFamily);
  const googleFontFamily = toGoogleFontFamilyParam(style.fontFamily);
  const hasEmoji = /\p{Extended_Pictographic}/u.test(text);
  const escapedText = escapeHtml(text).replace(/\n/g, '<br />');
  const frameStyles = [
    `position:absolute`,
    `left:${style.frameXPercent}%`,
    `transform:translateX(-50%)`,
    `bottom:${marginBottomPx}px`,
    `width:${textFrameWidthPx}px`,
    `max-width:${frameWidth}px`,
    `box-sizing:border-box`,
    `margin:0`,
  ];

  const baseTextStyles = [
    `position:relative`,
    `width:100%`,
    `font-family:"${fontFamily}","Noto Color Emoji","Apple Color Emoji","Segoe UI Emoji","Segoe UI Symbol","DejaVu Sans",sans-serif`,
    `font-size:${style.fontSize}px`,
    `font-weight:${style.fontWeight}`,
    `color:${style.fontColor}`,
    `line-height:${style.lineHeight}`,
    `letter-spacing:0`,
    `text-align:${style.textAlign}`,
    `white-space:pre-wrap`,
    `word-break:break-word`,
    `overflow-wrap:anywhere`,
    `box-sizing:border-box`,
    `padding:0`,
    `margin:0`,
  ];

  if (style.borderStyle === 3) {
    baseTextStyles.push(
      `background:${toRgba(style.backgroundColor, style.backgroundOpacity)}`,
      `padding:${style.boxPaddingY}px ${style.boxPaddingX}px`,
      `border-radius:${style.boxRadius}px`,
      `text-shadow:none`,
      `-webkit-text-stroke:0 transparent`
    );
  } else if (hasEmoji) {
    baseTextStyles.push(
      `text-shadow:0 2px 6px rgba(0,0,0,0.58)`,
      `-webkit-text-stroke:0 transparent`
    );
  } else {
    baseTextStyles.push(
      `-webkit-text-stroke:${style.outlineWidth}px ${style.outlineColor}`,
      `text-shadow:0 2px 6px rgba(0,0,0,0.55)`,
      `background:transparent`
    );
  }

  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8" />
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${googleFontFamily}:wght@400;700;900&display=swap" />
    <style>
      html, body {
        margin: 0;
        width: ${frameWidth}px;
        height: ${frameHeight}px;
        background: transparent;
        overflow: hidden;
      }
      .frame {
        position: relative;
        width: ${frameWidth}px;
        height: ${frameHeight}px;
        background: transparent;
      }
      .subtitle {
        ${baseTextStyles.join(';\n        ')};
      }
      .subtitle-frame {
        ${frameStyles.join(';\n        ')};
      }
    </style>
  </head>
  <body>
    <div class="frame">
      <div class="subtitle-frame">
        <div class="subtitle">${escapedText}</div>
      </div>
    </div>
  </body>
</html>`;
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
  const normalizedText = normalizeEmojiPresentation(text).normalize('NFC');
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
    
    const escapedText = escapeAssDialogueText(text);
    
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

async function renderOverlayFramesWithChromium(taskId: string, overlays: PreparedOverlay[], style: TextRenderStyle): Promise<OverlayFrame[]> {
  const executablePath = resolveChromiumExecutablePath();
  const overlayDir = path.join(dataDir, `${taskId}-overlays`);
  const framesDir = path.join(overlayDir, 'frames');
  await fs.ensureDir(framesDir);

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--font-render-hinting=medium',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 720, height: 1280, deviceScaleFactor: 1 });

    const frames: OverlayFrame[] = [];
    for (const [index, item] of overlays.entries()) {
      const startSeconds = item.overlay.startSeconds;
      const endSeconds = item.overlay.endSeconds;
      if (!(endSeconds > startSeconds)) {
        continue;
      }

      const imagePath = path.join(framesDir, `overlay-${String(index + 1).padStart(3, '0')}.png`);
      const html = buildOverlayFrameHtml(item.text, style);
      await page.setContent(html, { waitUntil: 'domcontentloaded' });
      await page.evaluate(async () => {
        if (document.fonts?.ready) {
          await document.fonts.ready;
        }
      });
      await page.screenshot({
        path: imagePath,
        type: 'png',
        omitBackground: true,
      });

      frames.push({
        startSeconds,
        endSeconds,
        imagePath,
      });
    }

    return frames;
  } finally {
    await browser.close();
  }
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

    const resolvedTextStyle = resolveTextStyle(input.textStyle);
    const preparedOverlays = input.textOverlays.map((overlay) => prepareOverlayForRender(overlay, resolvedTextStyle));
    const overlayWorkDir = path.join(dataDir, `${input.taskId}-overlays`);

    try {
      try {
        const overlayFrames = await renderOverlayFramesWithChromium(input.taskId, preparedOverlays, resolvedTextStyle);
        if (overlayFrames.length > 0) {
          const { graph, finalLabel } = buildOverlayFilterGraph(overlayFrames);
          const ffmpegArgs = [
            '-y',
            '-i',
            input.generatedVideoUrl,
            '-stream_loop',
            '-1',
            '-i',
            input.audioFilePath,
          ];

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
            outputPath
          );

          await runFfmpeg(ffmpegArgs);
          return outputPath;
        }
      } catch (error: any) {
        console.warn('[VideoPostprocessService] Chromium overlay renderer failed, fallback to ASS:', error?.message || error);
      }

      const assFilePath = await writeAssFile(input.taskId, preparedOverlays, resolvedTextStyle);
      const relativeAssPath = path.relative(process.cwd(), assFilePath);
      const filter = `subtitles='${escapeFilterValue(relativeAssPath)}'`;

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
      await fs.remove(overlayWorkDir);
    }

    return outputPath;
  }
}
