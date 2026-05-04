import fs from 'fs-extra';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { createChatCompletionWithRetry } from './gemini.service.js';
import type { ReferenceTextOverlay } from '../domain/reference-library.js';

const allowedAnchors: ReferenceTextOverlay['anchor'][] = [
  'top-left',
  'top-center',
  'top-right',
  'center-left',
  'center',
  'center-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toNumberOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeAnchor(value: unknown): ReferenceTextOverlay['anchor'] {
  if (typeof value !== 'string') {
    return 'top-center';
  }

  const anchor = value as ReferenceTextOverlay['anchor'];
  return allowedAnchors.includes(anchor) ? anchor : 'top-center';
}

function buildProviderRouting() {
  return {
    order: config.openRouter.providers.order,
    allow_fallbacks: config.openRouter.providers.allowFallbacks,
  };
}

function extractJsonObject(raw: string): string {
  const fencedMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const startIndex = raw.indexOf('{');
  const endIndex = raw.lastIndexOf('}');
  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    throw new Error('LLM did not return JSON for text overlays');
  }

  return raw.slice(startIndex, endIndex + 1);
}

function normalizeOverlays(value: unknown): ReferenceTextOverlay[] {
  const overlays: ReferenceTextOverlay[] = [];

  if (Array.isArray(value)) {
    for (const item of value) {
      if (!item || typeof item !== 'object') {
        continue;
      }

      const overlay = item as Record<string, unknown>;
      const text = typeof overlay.text === 'string' ? overlay.text.trim() : '';
      if (!text) {
        continue;
      }

      const startSeconds = Number(overlay.startSeconds);
      const endSeconds = Number(overlay.endSeconds);
      if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
        continue;
      }

      overlays.push({
        id: typeof overlay.id === 'string' && overlay.id.trim() ? overlay.id : randomUUID(),
        text,
        startSeconds,
        endSeconds,
        anchor: normalizeAnchor(overlay.anchor),
        xPercent: clamp(toNumberOr(overlay.xPercent, 0.5), 0, 1),
        yPercent: clamp(toNumberOr(overlay.yPercent, 0.12), 0, 1),
        fontSizePercent: clamp(toNumberOr(overlay.fontSizePercent, 0.036), 0.018, 0.09),
        textColor: typeof overlay.textColor === 'string' ? overlay.textColor : '#FFFFFF',
        box: Boolean(overlay.box),
        boxColor: typeof overlay.boxColor === 'string' ? overlay.boxColor : '#000000',
        boxOpacity: clamp(toNumberOr(overlay.boxOpacity, 0), 0, 1),
        isStatic: Boolean(overlay.isStatic),
      });
    }
  }

  return overlays;
}

export class TextOverlayService {
  public static async extractFromVideo(input: {
    videoUrl?: string;
    localPath?: string;
    analysis?: string;
  }): Promise<ReferenceTextOverlay[]> {
    const { videoUrl, localPath, analysis } = input;
    
    let videoContent: any;

    if (localPath && await fs.pathExists(localPath)) {
      const base64Video = await fs.readFile(localPath, { encoding: 'base64' });
      videoContent = {
        type: 'video_url',
        video_url: {
          url: `data:video/mp4;base64,${base64Video}`,
        },
      };
      console.log(`[TextOverlayService] Using base64 encoding for video from ${localPath}`);
    } else if (videoUrl) {
      videoContent = {
        type: 'video_url',
        video_url: {
          url: videoUrl,
        },
      };
      console.log(`[TextOverlayService] Using direct URL for video: ${videoUrl.slice(0, 50)}...`);
    } else {
      throw new Error('No video input provided (either videoUrl or localPath is required)');
    }

    const response = await createChatCompletionWithRetry(
      {
        model: config.openRouter.models.flash,
        provider: {
          order: ['google-vertex'],
          allow_fallbacks: false,
        },
        messages: [
          {
            role: 'system',
            content: `Ты извлекаешь только текстовые надписи из видео и возвращаешь только JSON.

Формат ответа:
{
  "overlays": [
    {
      "id": "overlay-1",
      "text": "точный текст на экране",
      "startSeconds": 0.0,
      "endSeconds": 2.5,
      "anchor": "top-center",
      "xPercent": 0.5,
      "yPercent": 0.12,
      "fontSizePercent": 0.042,
      "textColor": "#FFFFFF",
      "box": false,
      "boxColor": "#000000",
      "boxOpacity": 0.0,
      "isStatic": false
    }
  ]
}

Правила:
- Извлекай ТОЛЬКО графические текстовые надписи (оверлеи, титры, плашки), наложенные поверх видео при монтаже.
- КАТЕГОРИЧЕСКИ ИГНОРИРУЙ текст на физических объектах (этикетки на бутылках, текст на коробках, вывески на зданиях, надписи на одежде).
- Возвращай только валидный JSON, без markdown.
- Если текста нет, верни {"overlays":[]}.
- Определи все видимые титры, их тайминг и положение на кадре.
- Помечай "isStatic": true для текста, который присутствует почти весь ролик (вотермарки, логотипы).
- anchor используй: top-left, top-center, top-right, center-left, center, center-right, bottom-left, bottom-center, bottom-right.
- xPercent и yPercent в диапазоне 0..1.
- fontSizePercent в долях высоты кабора (0.025..0.08).
- Если текст выглядит как субтитры, укажи box=true.
- Если текст многострочный, сохрани переносы строк \n.`,
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Извлеки параметры надписей из этого видео. Дополнительный контекст анализа:
${analysis || 'Нет дополнительного анализа.'}`,
              },
              videoContent,
            ],
          },
        ],
      },
      'Text Overlay Extraction',
      config.openRouter.models.flashFallback
    );

    const content = response.data.choices[0]?.message?.content;
    if (!content) {
      throw new Error('Empty text overlay extraction result');
    }

    const parsed = JSON.parse(extractJsonObject(content));
    return normalizeOverlays(parsed?.overlays);
  }
}
