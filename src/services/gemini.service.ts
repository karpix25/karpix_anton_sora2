import axios from 'axios';
import fs from 'fs-extra';
import { config } from '../config.js';
import type { Project } from '../domain/project.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildProviderRouting() {
  return {
    order: config.openRouter.providers.order,
    allow_fallbacks: config.openRouter.providers.allowFallbacks,
  };
}

function getRetryDelayMs(error: any, attempt: number): number {
  const retryAfterSeconds = Number(error?.response?.headers?.['retry-after']);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return retryAfterSeconds * 1000;
  }

  const baseDelays = [3000, 8000, 15000];
  return baseDelays[Math.min(attempt, baseDelays.length - 1)] || 15000;
}

function isRetryableOpenRouterError(error: any): boolean {
  const status = Number(error?.response?.status);
  return status === 429 || status >= 500;
}

function formatOpenRouterError(error: any): string {
  const status = Number(error?.response?.status);
  const apiErrorMessage = error?.response?.data?.error?.message || error?.response?.data?.message;
  const providerName = error?.response?.data?.error?.metadata?.provider_name;
  const providerRaw = error?.response?.data?.error?.metadata?.raw;
  const baseMessage = error?.message || 'Unknown OpenRouter error';

  const parts: string[] = [];

  if (status) {
    parts.push(`HTTP ${status}`);
  }
  if (apiErrorMessage) {
    parts.push(String(apiErrorMessage));
  }
  if (providerName || providerRaw) {
    parts.push(...[providerName ? `provider=${providerName}` : '', providerRaw ? `raw=${providerRaw}` : ''].filter(Boolean));
  }
  if (status === 401) {
    parts.push('check OPENROUTER_API_KEY in .env');
  }
  if (baseMessage && !parts.includes(baseMessage)) {
    parts.push(baseMessage);
  }

  return parts.length > 0 ? parts.join(' | ') : baseMessage;
}

export async function createChatCompletionWithRetry(
  payload: any,
  label: string,
  fallbackModel?: string
) {
  const maxAttempts = 4;
  let currentPayload = { ...payload };

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await axios.post(
        `${config.openRouter.baseUrl}/chat/completions`,
        currentPayload,
        {
          headers: {
            'Authorization': `Bearer ${config.openRouter.apiKey}`,
            'Content-Type': 'application/json',
          },
        }
      );
    } catch (error: any) {
      const formattedError = formatOpenRouterError(error);
      const retryable = isRetryableOpenRouterError(error);
      const isLastAttempt = attempt === maxAttempts - 1;
      const status = error?.response?.status;

      console.error(`${label} Error:`, error.response?.data || error.message);

      // If it's a 429 and we have a fallback model, and we've tried few times (or it's the last attempt)
      // we switch to the fallback model.
      if (status === 429 && fallbackModel && currentPayload.model !== fallbackModel) {
        console.warn(`${label}: Switching to fallback model ${fallbackModel} due to 429 error`);
        currentPayload.model = fallbackModel;
        // Optional: reset attempt counter or just continue. 
        // Let's just continue to keep it within maxAttempts for now, or we could reset it.
        // Actually, switching model might deserve a full set of retries.
        // But to avoid infinite loops or too many retries, let's just use the remaining attempts.
        continue; 
      }

      if (!retryable || isLastAttempt) {
        throw new Error(formattedError);
      }

      const delayMs = getRetryDelayMs(error, attempt);
      console.warn(`${label}: retrying after ${delayMs}ms due to transient upstream error`);
      await sleep(delayMs);
    }
  }

  throw new Error(`${label} failed after retries`);
}

function stripTextOverlaySections(videoAnalysis: string): string {
  return videoAnalysis
    .replace(/###\s*\*\*3\.\s*Text\s*&\s*Overlays Detection[\s\S]*?(?=###\s*\*\*4\.|$)/i, '')
    .replace(/###\s*\*\*SUMMARY OF TEXT OVERLAYS\*\*[\s\S]*$/i, '')
    .replace(/^\s*\*\s*Text Overlay:.*$/gim, '')
    .replace(/^\s*Text Overlay:.*$/gim, '')
    .trim();
}

export class GeminiService {
  /**
   * Analyzes an Instagram video beat-by-beat using Gemini 2.0 Flash via OpenRouter.
   * Focuses on breakdown of shots, behavior, meaning, and technical cues.
   */
  public static async analyzeVideo(input: { videoUrl?: string; localPath?: string }): Promise<string> {
    const { videoUrl, localPath } = input;
    
    try {
      let videoContent: any;

      if (localPath && await fs.pathExists(localPath)) {
        const base64Video = await fs.readFile(localPath, { encoding: 'base64' });
        videoContent = {
          type: 'video_url',
          video_url: {
            url: `data:video/mp4;base64,${base64Video}`,
          },
        };
        console.log(`[GeminiService] Using base64 encoding for video from ${localPath}`);
      } else if (videoUrl) {
        videoContent = {
          type: 'video_url',
          video_url: {
            url: videoUrl,
          },
        };
        console.log(`[GeminiService] Using direct URL for video: ${videoUrl.slice(0, 50)}...`);
      } else {
        throw new Error('No video input provided (either url or localPath is required)');
      }

      const response = await createChatCompletionWithRetry(
        {
          model: config.openRouter.models.flash,
          provider: buildProviderRouting(),
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `Выполни глубокий технический и режиссерский реверс-инжиниринг видео по протоколу Regisseur Protocol v2.1. Твоя цель — создать исчерпывающее описание (Prompt Sheet), которое позволит нейросети Veo 3.1 воссоздать это видео с сохранением физики и стиля.

                  1. Аналитический блок:
                  - Semantic Core: В чем заключается главный визуальный хук или физический механизм (морфинг, левитация, резкая смена планов, комедийный тайминг).
                  - Optical Geometry: Определи тип линзы (Wide Angle 24mm, Portrait 85mm) и глубину резкости (Bokeh). Тип камеры: UGC (тряска, цифровой шум) или стационарный штатив/кинокамера.
                  - Lighting & Materials: Определи схему света (контрастный боковой, мягкий заполняющий). Опиши свойства материалов: как свет отражается от кожи, металла или пластика (Glossiness/Roughness).
                  - Spatial Physics & Occlusion: Опиши эшелонирование кадра. Какие объекты находятся на переднем плане и как они перекрывают друг друга при движении (Z-depth).
                  - Kinetic Dynamics: Опиши инерцию тел, волос и тканей. Как меняется натяжение одежды при движении? Укажи векторы смещения центра тяжести.

                  3. Text & Overlays Detection (CRITICAL):
                  - Выяви все текстовые элементы на видео.
                  - Категоризируй как: "Static Text" (неподвижная плашка), "Dynamic Text" (анимированный или движущийся текст) или "Subtitles" (субтитры речи).
                  - Для каждого элемента укажи: [Start - End] тайминг, точный текст и его тип.

                  4. Выходной формат (Strict Timeline):
                  Выдай результат в виде списка по таймкодам (каждые 1-2 сек или при смене действия). Для каждого отрезка укажи:
                  - [Time]: (например, 00:00 - 00:02)
                  - Action: Техническое описание движения.
                  - Camera: Движение камеры (Pan, Tilt, Zoom, Shake).
                  - Physics Note: Нюансы физики (ткань, инерция, свет).
                  - Text Overlay: Присутствует ли текст в этом фрагменте? Если да, какой.
                  
                  В конце добавь отдельный блок "SUMMARY OF TEXT OVERLAYS" со списком всех найденных текстов.`,
                },
                videoContent,
              ],
            },
          ],
        },
        'Gemini Analysis',
        config.openRouter.models.flashFallback
      );

      const analysis = response.data.choices[0]?.message?.content;
      if (!analysis) {
        throw new Error('Empty analysis result from Gemini Flash');
      }
      return analysis;
    } catch (error: any) {
      throw new Error(`Video analysis failed: ${error.message}`);
    }
  }

  /**
   * Generates a Sora 2/Veo 3.1 prompt using Gemini 2.0 Pro.
   * Joins the video analysis with the product photo reference.
   * @param videoAnalysis Description of the reference video.
   * @param productPhotoUrl URL of the product photo (usually from Telegram).
   * @param targetModel The target model ('sora-2' or 'veo-3-1').
   */
  public static async generateClonningPrompt(
    input: {
      videoAnalysis: string;
      targetModel: 'sora-2' | 'veo-3-1';
      fallbackProductPhotoUrl?: string;
      project?: Project | null;
      projectReferenceImageUrls?: string[];
    }
  ): Promise<string> {
    try {
      const {
        videoAnalysis,
        targetModel,
        fallbackProductPhotoUrl,
        project,
        projectReferenceImageUrls = [],
      } = input;

      const cleanVideoAnalysis = stripTextOverlaySections(videoAnalysis);

      const projectContextBlock = `
        PROJECT INPUTS:
        - Project Name: ${project?.name || 'Not specified'}
        - Product Name: ${project?.productName || 'Not specified'}
        - Product Description: ${project?.productDescription || 'Not specified'}
        - Target Audience: ${project?.targetAudience || 'Not specified'}
        - Call To Action: ${project?.cta || 'Not specified'}
        - Extra Prompting Rules: ${project?.extraPromptingRules || 'Not specified'}
      `;

      const systemInstructions = `
        You are writing prompts for short product videos in Sora 2 and Veo 3.1.
        Your task is to turn the reference video analysis into a SIMPLE, SHORT, CLEAR action prompt.

        CORE PRINCIPLES:
        - Write like a human describing what is happening on screen.
        - Use simple words.
        - Focus on visible action.
        - Keep the prompt compact.
        - One clear action per time block.
        - Do not explain the analysis. Turn it into a simple sequence of actions.

        WHAT TO AVOID:
        - No technical film language unless absolutely necessary.
        - No terms like semantic core, optical geometry, kinetic dynamics, camera platform, grading rationale, shot rationale.
        - No long descriptions of physics or lens theory.
        - No complex metaphors unless they directly help the visual result.

        STRUCTURE:
        - Use short time blocks like [00:00-00:02].
        - Usually write 3 to 5 blocks.
        - Each block should be 1 or 2 short sentences.
        - Keep the whole prompt short enough to feel like a clean storyboard.
        - Every block must describe one main visible action.

        PRODUCT VIDEO LOGIC:
        - Preserve the simple story logic of the original reel.
        - Replace the original product with the real product from the project inputs and reference images.
        - Show the product in a natural way.
        - If the original video mainly demonstrates an effect, focus on that effect.
        - If the original video ends with a quick product reveal, keep that ending.
        - The final result should feel like a clear social-media product demo.

        PROMPT WRITING RULES:
        - Describe what the person does.
        - Describe what changes visually.
        - Describe what the viewer notices.
        - Mention lighting or setting only if it is important for the look.
        - Keep product details that matter for recognition.
        - Prefer simple verbs like holds, brushes, turns, smiles, shows, applies, lifts, moves, looks.

        STRICT RULE: NO TEXT INSIDE GENERATED VIDEO.
        - Do NOT include any text overlays, subtitles, titles, captions, stickers, UI elements, or on-screen text.
        - The generated video must be clean.
        - Text from the original video will be added later in post-production.

        REFERENCE VIDEO ANALYSIS:
        ${cleanVideoAnalysis}

        ${projectContextBlock}

        OUTPUT REQUIREMENTS:
        - Return only the final prompt.
        - No explanations.
        - No meta notes.
        - No headings outside the time blocks.
        - End naturally after the final reveal.

        TARGET STYLE EXAMPLE:
        [00:00-00:02] A woman slowly brushes her hair and looks at the result in the mirror.
        [00:02-00:04] She runs her hand through her hair to show how soft and smooth it looks.
        [00:04-00:06] She turns slightly and moves her hair so the light catches the shine.
        [00:06-00:08] She briefly holds up the product and smiles at the camera.
      `;

      const userContent: Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      > = [
        {
          type: 'text',
          text:
            'Generate a short timestamped product-video prompt in plain language. Keep it simple, visual, and action-based. Use 3 to 5 short blocks. One main action per block. End with a short product reveal if it fits the reference logic.',
        },
      ];

      for (const imageUrl of projectReferenceImageUrls) {
        userContent.push({
          type: 'image_url',
          image_url: {
            url: imageUrl,
          },
        });
      }

      if (fallbackProductPhotoUrl) {
        userContent.push({
          type: 'image_url',
          image_url: {
            url: fallbackProductPhotoUrl,
          },
        });
      }

      const response = await createChatCompletionWithRetry(
        {
          model: config.openRouter.models.pro,
          provider: buildProviderRouting(),
          messages: [
            {
              role: 'system',
              content: systemInstructions,
            },
            {
              role: 'user',
              content: userContent,
            },
          ],
        },
        'Gemini Prompt Generation'
      );

      const finalPrompt = response.data.choices[0]?.message?.content;
      if (!finalPrompt) {
        throw new Error('Empty prompt result from Gemini Pro');
      }
      return finalPrompt;
    } catch (error: any) {
      throw new Error(`Prompt generation failed: ${error.message}`);
    }
  }
}
