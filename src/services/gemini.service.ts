import axios from 'axios';
import fs from 'fs-extra';
import { config } from '../config.js';
import { AdminNotifierService } from './admin-notifier.service.js';
import type { Project, VideoModel } from '../domain/project.js';
import type { ReferenceTextOverlay } from '../domain/reference-library.js';

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
      const response = await axios.post(
        `${config.openRouter.baseUrl}/chat/completions`,
        currentPayload,
        {
          headers: {
            'Authorization': `Bearer ${config.openRouter.apiKey}`,
            'Content-Type': 'application/json',
          },
        }
      );

      // Check for empty response content which often indicates a safety block or provider glitch
      const content = response.data.choices?.[0]?.message?.content;
      if (!content) {
        console.warn(`${label}: Received empty response content. Attempt ${attempt + 1}/${maxAttempts}.`);

        if (attempt >= maxAttempts - 1) {
          const responseShape = JSON.stringify(response.data || {}).slice(0, 1000);
          throw new Error(`${label} returned empty content after ${maxAttempts} attempts. response=${responseShape}`);
        }
        
        // If we have a fallback model and it's not the last attempt, try switching to fallback
        if (fallbackModel && currentPayload.model !== fallbackModel) {
          console.warn(`${label}: Switching to fallback model ${fallbackModel} due to empty content`);
          currentPayload.model = fallbackModel;
        }
        
        await sleep(getRetryDelayMs(null, attempt));
        continue;
      }

      return response;
    } catch (error: any) {
      const formattedError = formatOpenRouterError(error);
      const retryable = isRetryableOpenRouterError(error);
      const isLastAttempt = attempt === maxAttempts - 1;
      const status = error?.response?.status;

      console.error(`${label} Error:`, error.response?.data || error.message);

      if (status === 429 && fallbackModel && currentPayload.model !== fallbackModel) {
        console.warn(`${label}: Switching to fallback model ${fallbackModel} due to 429 error`);
        currentPayload.model = fallbackModel;
        continue; 
      }

      if (!retryable || isLastAttempt) {
        const lowercaseError = formattedError.toLowerCase();
        if (
          status === 402 || 
          lowercaseError.includes('insufficient') || 
          lowercaseError.includes('credit') || 
          lowercaseError.includes('balance')
        ) {
          console.warn(`[GeminiService] Detected OpenRouter balance/credit error. Notifying admins...`);
          AdminNotifierService.notifyBalanceError('OpenRouter (Gemini)', formattedError).catch(err => 
            console.error('[GeminiService] Failed to notify admins:', err.message)
          );
        }
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
    .replace(/###\s*(?:\*\*)?\s*3\.\s*Text\s*&\s*Overlays Detection(?:\*\*)?[\s\S]*?(?=###\s*(?:\*\*)?\s*4\.|$)/i, '')
    .replace(/###\s*\*\*SUMMARY OF TEXT OVERLAYS\*\*[\s\S]*$/i, '')
    .replace(/^\s*-\s*Text on screen:.*$/gim, '')
    .replace(/^\s*\*\s*Text Overlay:.*$/gim, '')
    .replace(/^\s*Text Overlay:.*$/gim, '')
    .trim();
}

function getProjectLanguageLabel(project?: Project | null): string {
  return project?.projectLanguage === 'en' ? 'English' : 'Russian';
}

function getProjectLanguageInstruction(project?: Project | null): string {
  return project?.projectLanguage === 'en'
    ? 'All generated overlay text must be in English.'
    : 'All generated overlay text must be in Russian.';
}

function extractJsonObject(raw: string): string {
  const fencedMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const startIndex = raw.indexOf('{');
  const endIndex = raw.lastIndexOf('}');
  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    throw new Error('LLM did not return JSON');
  }

  return raw.slice(startIndex, endIndex + 1);
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
          provider: {
            order: ['google-vertex'],
            allow_fallbacks: false,
          },
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `You are performing a video reverse-engineering pass for later recreation. Think like a careful video analyst: first identify what is visibly present, then infer only what the evidence supports. Do not write a cinematic essay. Write a compact production note that can be used to clone the reference later.

Treat the video as a sequence of key visual moments. Prefer concrete observations over general summaries. If something is not clearly visible, say so. Do not invent hidden actions, off-screen causes, or design details.

Use this structure exactly:

### 1. OVERVIEW
- Duration.
- One-shot or multi-shot.
- Main subject.
- Setting.
- Core visual hook.
- Primary action arc in one or two lines.

### 2. TIMELINE / KEY MOMENTS
For each beat, use a short block with:
- [Time]
- Visible evidence: only what can be seen on screen
- Motion: subject motion and camera motion
- Subject & props: people, products, hands, objects, environment
- Object state: open/closed, held/released, clean/dirty, active/inactive, etc.
- Continuity: what must stay consistent across the next beat
- Text on screen: exact text if present, or "none"

Rules for the timeline:
- Break the video at real visual changes, not every few seconds.
- Capture the first visible state, the transition, and the final visible state.
- If the video is a continuous shot, say so explicitly.
- If there are cuts, say where they happen.
- Note micro-events that matter for later cloning: hand enters frame, object is picked up, product changes state, face reaction changes, reveal appears, etc.
- Be precise about framing, subject placement, and hand-to-object contact.

### 3. TEXT & OVERLAYS DETECTION
- List every on-screen graphic text element.
- Categorize each item as Static Text, Dynamic Text, or Subtitles.
- For each item, include exact text and approximate [Start - End] timing.
- Ignore printed labels on physical objects unless they are clearly part of the video overlay design.

### 4. COPY MAP
- Must preserve: 3 to 7 details that are essential to recreate the reference.
- Can change: details that may be swapped when re-skinning to a new product.
- Likely failure points: details the generator may get wrong if the analysis is too loose.
- Best cloning strategy: one short paragraph summarizing how to reproduce the reference rhythm, framing, and action logic.

Output must be concise, factual, and structured exactly with these four sections. No markdown intro, no extra explanation, no closing commentary.`,
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
      targetModel: VideoModel;
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

      const rawVideoAnalysis = String(videoAnalysis || '').trim();
      const cleanVideoAnalysis = stripTextOverlaySections(rawVideoAnalysis);
      const effectiveVideoAnalysis = cleanVideoAnalysis || rawVideoAnalysis;

      if (!effectiveVideoAnalysis) {
        throw new Error('Cannot generate prompt: reference video analysis is empty');
      }

      console.log(
        `[GeminiService] Prompt generation input: project=${project?.id || 'none'}, analysisLength=${rawVideoAnalysis.length}, cleanAnalysisLength=${cleanVideoAnalysis.length}, images=${projectReferenceImageUrls.length + (fallbackProductPhotoUrl ? 1 : 0)}`
      );

      const projectContextBlock = `
        PROJECT INPUTS:
        - Project Name: ${project?.name || 'Not specified'}
        - Product Name: ${project?.productName || 'Not specified'}
        - Product Description: ${project?.productDescription || 'Not specified'}
        - Target Audience: ${project?.targetAudience || 'Not specified'}
        - Call To Action: ${project?.cta || 'Not specified'}
        - Project Text Language: ${getProjectLanguageLabel(project)}
        - Extra Prompting Rules: ${project?.extraPromptingRules || 'Not specified'}
        - DESIRED SHOOTING STYLE: ${(await (await import('../storage/system-config-store.js')).systemConfigStore.getConfig()).grokStyle}
      `;

      const systemInstructions = `
        You are writing prompts for short product videos in Sora 2 and Veo 3.1.
        Your task is to turn the reference video analysis into a SIMPLE, SHORT, CLEAR action prompt.

        CORE PRINCIPLES (DIRECTORIAL STYLE):
        - Start with the "Look and Feel": Describe camera framing, lens (e.g. 35mm), and lighting in the first two sentences.
        - Write like a professional director/cinematographer describing a scene.
        - Use simple verbs but retain ALL CRITICAL DETAILS (props, emotions, objects).
        - Maintain a "Subject Anchor": Clearly state the main character and their key attributes (clothing, accessories) early.
        - Focus on visible action and CHARACTER BEHAVIOR.
        - Keep the prompt compact but vivid.
        - One clear action per time beat.
        - Do not explain the analysis. Turn it into a cinematic storyboard.

        MODERATION-SAFE PROMPTING (STRICT):
        - Write the final prompt so it is safe for strict commercial video generation moderation on the first attempt.
        - If the reference analysis contains risky, adult, provocative, violent, medical, illegal, self-harm, weapon, drug, dangerous-stunt, or shock-content cues, preserve only the harmless visual structure and replace the risky action with a safe everyday commercial equivalent.
        - Never include sexual, sensual, erotic, nude, lingerie, fetish, intimate-touching, body-part-focused, or provocative wording.
        - Keep every person clearly adult, fully clothed, non-provocative, and presented in a neutral lifestyle or commercial context.
        - Avoid describing exposed skin, curves, chest, hips, seductive poses, bedroom intimacy, or flirtatious behavior.
        - Avoid violence, threats, injuries, blood, weapons, fear, distress, accidents, dangerous challenges, or unsafe behavior. Replace with calm gestures, product handling, walking, grooming, cleaning, organizing, cooking, styling, or other safe daily actions.
        - Avoid medical claims, diagnosis, before/after disease treatment, pain relief, healing, scars, wounds, injections, pills, or clinical procedures. For wellness/beauty products, describe only cosmetic appearance, comfort, routine, texture, shine, neatness, freshness, or confidence.
        - Avoid illegal drugs, alcohol abuse, tobacco, vaping, gambling, political persuasion, and financial promises.
        - Do not mention real celebrities, public figures, copyrighted characters, brands, logos, watermarks, UI screens, social media app interfaces, or recognizable third-party IP unless they are part of the provided product images and project context.
        - Do not mention moderation, policy, blocked content, safety rewrite, or any meta-safety language in the final prompt.
        - When a risky reference detail is removed, do not explain the removal; silently substitute a safe visual action that keeps the same timing, framing, and motion rhythm.

        ANTI-STATIC DYNAMIC START (CRITICAL):
        - The video MUST NOT start with a static frame or a "freeze" of the reference image.
        - Describe immediate action or camera movement from frame 0.0.
        - Ensure the subject or product is already in motion or the camera is panning/zooming as the video begins.
        - If the scenario requires a "before" state (e.g. dirty, messy), start exactly with that state, using the reference image ONLY as a guide for the product's underlying shape and design, NOT its surface condition.
        
        CAMERAWORK & SHOOTING STYLE:
        - If "vlog" style is requested: Use keywords: "Shot on iPhone", "handheld camera motion", "vertical video", "UGC style", "natural lighting", "realistic micro-jitters", "raw footage". Avoid "cinematic", "8k", "perfect lighting".
        - If "cinematic" style is requested: Use keywords: "Cinematic lighting", "professional camera rig", "8k resolution", "stable motion", "perfect color grading".

        PHYSICAL LOGIC & ANTI-HALLUCINATION (STRICT):
        - No Telekinesis: Objects must NEVER move by themselves. They must be physically carried, lifted, or pushed by a character's hand using a realistic grip.
        - Start State Anchor: Explicitly state the exact position of products at 0.0s (e.g., "The bottle is sitting firmly on the wooden table").
        - Transition Trajectory: Describe the "how" of movement. (e.g., "The character's right hand reaches down, fingers wrap around the bottle's neck, and they lift it with natural weight and inertia").
        - Directional Interaction: If a spray or tool is used, specify the TARGET. (e.g., "@image1 The nozzle is pointed directly at her hair, and the mist travels in a straight line toward the strands, not toward the camera").
        - Visual Continuity: Every movement must start from the position shown in the reference image. No jumping between states without a visible transition.
        - Interaction with @image1: Always use "@image1" as the anchor point for the product's initial location and the person's starting pose.
        - Hand Interaction (MANDATORY): If an object is moving, you MUST describe the hand holding it, including the position of the thumb and fingers (e.g. "gripped tightly between thumb and forefinger"). This prevents "floating" or "telepathic" objects.

        HUMAN NATURALISM & BEHAVIORAL LOGIC (STRICT):
        - Tool Lifecycle: Any auxiliary tool (spoon, phone, key, opener) must have a logical cycle: Picked up -> Used -> Placed aside. Never describe an action where a tool is used and then ignored or "absorbed" into the next action.
        - Common Sense Habits: Follow standard human social norms and common sense. For example, a person must REMOVE a stirrer or spoon from a glass before drinking from it. They must open a package before taking something out.
        - Natural Transitions: Explicitly describe the "transition" movements (e.g., "sets the spoon on the saucer," "wipes hands with a cloth") to ensure behavioral continuity and avoid surreal "glitches" in human actions.
        - Single Focus: Humans generally don't perform two incompatible complex actions simultaneously. Ensure actions follow a logical sequential order.

        PRODUCT CONSISTENCY & STATE ANCHOR (STRICT):
        - Your main mission is a "Universal Product Re-skin".
        - Maintain the product's physical identity (size, proportions, key design elements, materials) 100% identically from the first frame to the last.
        - Once a "Product Effect" or "State Change" is achieved (e.g., surface becomes clean, hair becomes shiny, light turns on), this new state MUST persist and remain stable until the very end of the video. Never revert the product to its initial state unless the reference video explicitly does so.
        - Do not allow the product's design or dimensions to drift or change between beats.

        EMOTIONS & PROPS (STRICT):
        - Describe facial micro-expressions (smiles, looking surprised, serious gaze).
        - Ensure every key prop mentioned in the analysis (e.g. headphones, phone, jewelry) is explicitly included in the prompt.
        - Describe how the person interacts with these props.

        SHOT CONTINUITY (STRICT):
        - If the analysis describes a ONE-SHOT or single continuous plan, the generated prompt MUST explicitly state "Single continuous shot without any cuts" or "Seamless one-take video".
        - Do NOT allow the model to invent cuts between time blocks if the reference is a single shot.

        VEO 3.1 OPTIMIZED NARRATIVE (GOOGLE GUIDE COMPLIANT):
        - Follow the SAECL Framework for every beat:
          1. Subject: Who is in focus? Ensure the subject maintains a consistent European/Caucasian appearance to match the brand identity.
          2. Action: What is the specific motion?
          3. Environment: Specific details of the surroundings.
          4. Camera: Lens type (e.g., 35mm), angle, and motion (panning, tracking).
          5. Lighting: Source and quality (e.g., volumetric, natural daylight).
        - Use narrative flow: Instead of keywords, write a cohesive descriptive sentence for each beat.
        - Character Continuity: Explicitly describe the subject as a "European woman/man with Caucasian features" in every beat to ensure a stable and consistent appearance throughout the video.

        FIDELITY & OPTICAL REALISM:
        - Skin: Use "visible skin pores," "subsurface scattering," "natural skin texture," and "fine facial details."
        - Avoid Fluff: NEVER use "4k", "8k", "hyperrealistic", "amazing", or "high quality". Veo 3.1 ignores these.
        - Camera: Prefer "Shot on 35mm film grain," "Shot on iPhone 15 Pro (vlog style)," "shallow depth of field," or "anamorphic lens flares."

        WHAT TO AVOID:
        - No technical film language unless absolutely necessary.
        - No terms like semantic core, optical geometry, kinetic dynamics, camera platform, grading rationale, shot rationale.
        - No long descriptions of physics or lens theory.
        - No complex metaphors unless they directly help the visual result.

        STRUCTURE:
        - Use the format: "0.0s – 2.0s: [Action description]"
        - Maximum 3 to 5 beats.
        - Each beat should be 1 or 2 concise sentences.
        - Keep the whole prompt short enough to feel like a high-speed production brief.
        - Every beat must describe one main visible movement.

        PRODUCT VIDEO LOGIC:
        - Preserve the simple story logic of the original reel.
        - Keep the same timeline structure and action order as the reference analysis.
        - Do not invent new scenes that are absent in the reference.
        - Preserve the original shot composition and camera distance from the reference.
        - If the reference is a single portrait take, keep it as a single portrait take.
        - If the reference shows a person, keep a person in frame for the same beats.
        - If the reference is medium/portrait framing, do not switch to isolated macro product shots.
        - Keep the same demonstration mechanics as in the reference (same kind of hand motion and reveal rhythm).
        PRODUCT INTEGRATION (CRITICAL):
        - Your main mission is to RE-SKIN the reference video with the NEW product.
        - Look at the provided product images carefully. This is the ONLY product that should appear.
        - Use the Project Product Name and Product Description as your guide.
        - NEVER mention the product from the reference analysis if it's different.
        - Describe the product's appearance (color, shape, material) based on the images.
        - The person in the video must interact with the NEW product exactly as they did with the old one, but the visual description must match the NEW product.
        - If the project relates to hair/beauty, ensure the "product" being demonstrated (e.g., hair texture, color results) matches the project inputs.
        - If the original video ends with a quick product reveal, keep that ending using the new product.
        - If the reference has no obvious product moment, integrate the product natively into the same real-life action flow (as a natural prop already present in scene), without changing the scene logic.
        - In "no product in reference" cases, the product should appear organically from the first beat or early in the same action context, not as a separate promo insert.
        - Never force a dedicated advertising shot if the reference does not contain one.
        - Forbidden in this mode: isolated packshot, hard cut to clean studio product frame, "hero shot" on neutral background, logo-like lockup composition, sudden end-card style reveal.
        - Product must feel like part of behavior and story, not an external ad overlay.

        PROMPT WRITING RULES:
        - Describe what the person does and how they feel (mimicry).
        - Describe what changes visually.
        - Describe what the viewer notices.
        - Keep framing language explicit in each block (e.g. medium portrait, chest-up, close-up of hair section in hand).
        - Keep background context consistent with reference unless project rules override it.
        - Mention lighting or setting only if it is important for the look.
        - Keep product details that matter for recognition.
        - Prefer simple verbs like holds, brushes, turns, smiles, shows, applies, lifts, moves, looks.

        STRICT RULE: ABSOLUTELY NO TEXT, LETTERS, OR NUMBERS INSIDE GENERATED VIDEO.
        - The generated video MUST be completely "clean".
        - Do NOT include any: text overlays, subtitles, titles, captions, stickers, UI elements, watermarks, or on-screen labels.
        - Do NOT describe any characters (letters/numbers) appearing on objects, clothes, or backgrounds.
        - Even if the reference video has text, you must IGNORE it entirely and describe ONLY the visual action and scenery.
        - You are strictly forbidden from including phrases like "with text", "showing caption", or "subtitle appears".
        - Text from the original video will be added later in post-production by a different system. Your job is ONLY the visual footage.
        - Post-production text language for that different system: ${getProjectLanguageLabel(project)}.

        REFERENCE VIDEO ANALYSIS:
        ${effectiveVideoAnalysis}

        ${projectContextBlock}

        OUTPUT REQUIREMENTS:
        - Return only the final prompt.
        - Absolutely no mentions of text, titles, or overlays.
        - No explanations.
        - No meta notes.
        - No headings outside the time blocks.
        - Keep the same number of time blocks as in the reference when possible.
        - End naturally after the final action from the reference.
        - Do not add a forced "final reveal" unless the reference itself clearly has a reveal beat.

        TARGET STYLE EXAMPLE:
        0.0s – 3.0s: Action begins immediately. Medium-shot on an 85mm lens. A woman is already in motion, satisfied and smiling as she turns toward a mirror, holding the product.
        3.0s – 6.0s: She demonstrates the product effect clearly; the surface becomes instantly polished and remains sparkling as she moves.
        6.0s – 8.0s: She finishes the action, looking into the camera satisfyingly, with the product and its effect (polished surface) remaining perfectly consistent and visible.
      `;

      const userContent: Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      > = [
        {
          type: 'text',
          text:
            `Generate a short timestamped product-video prompt in plain language. Keep it simple, visual, and action-based. Use 3 to 5 short blocks. One main action per block. Keep product integration native to the original action flow; do not create ad-like insert shots. Add final reveal only if the reference clearly has it.

Reference video analysis to use:
${effectiveVideoAnalysis}`,
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
        'Gemini Prompt Generation',
        config.openRouter.models.flash
      );

      const finalPrompt = response.data.choices?.[0]?.message?.content;
      if (!finalPrompt) {
        console.error('[GeminiService] Empty prompt result. Full response:', JSON.stringify(response.data, null, 2));
        throw new Error('Empty prompt result from Gemini Pro (possibly safety filter or provider error)');
      }
      return finalPrompt;
    } catch (error: any) {
      console.error('[GeminiService] Prompt generation failed:', error.message);
      throw new Error(`Prompt generation failed: ${error.message}`);
    }
  }

  /**
   * Rewrites a generation prompt after provider moderation blocks it.
   * Keeps the reference structure, but removes risky wording and adult/body-focused cues.
   */
  public static async rewritePromptForModerationFallback(input: {
    originalPrompt: string;
    videoAnalysis: string;
    targetModel: VideoModel;
    project?: Project | null;
    projectReferenceImageUrls?: string[];
  }): Promise<string> {
    const {
      originalPrompt,
      videoAnalysis,
      targetModel,
      project,
      projectReferenceImageUrls = [],
    } = input;

    const cleanVideoAnalysis = stripTextOverlaySections(videoAnalysis);
    const systemInstructions = `
      You rewrite short product-video prompts after a video provider moderation block.

      Goal:
      - Keep the same product, scene logic, camera flow, and simple action beats.
      - Make the prompt safe for strict commercial video moderation.

      Safety rewrite rules:
      - Remove all sexual, sensual, revealing, intimate, fetish, nude, bedroom, lingerie, body-part-focused, or provocative wording.
      - For clothing/fashion products, describe fit, fabric, silhouette, styling, movement, and confident everyday presentation. Do not describe exposed skin, curves, chest, hips, seductive poses, or erotic appeal.
      - For beauty products, describe grooming, clean texture, shine, neat styling, practical use, and satisfied expression. Avoid intimate body language.
      - Use neutral commercial language: everyday lifestyle, catalog, UGC, fitting-room mirror, street style, office, home routine.
      - Keep people fully clothed and non-provocative.
      - Do not include text overlays, subtitles, captions, labels, UI, watermarks, or visible letters/numbers inside the generated video.
      - Do not mention moderation, safety, policy, blocked content, sexuality, or anything meta in the output.

      Output:
      - Return only the rewritten final video prompt.
      - Use 3 to 5 timestamped beats.
      - Keep it under 900 characters if possible.
      - Target model: ${targetModel}

      Project:
      - Name: ${project?.name || 'Not specified'}
      - Product: ${project?.productName || 'Not specified'}
      - Description: ${project?.productDescription || 'Not specified'}
      - Audience: ${project?.targetAudience || 'Not specified'}
      - Extra rules: ${project?.extraPromptingRules || 'Not specified'}

      Reference analysis:
      ${cleanVideoAnalysis}

      Blocked prompt to rewrite:
      ${originalPrompt}
    `;

    const userContent: Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    > = [
      {
        type: 'text',
        text: 'Rewrite the blocked prompt as a safe, neutral, commercial product video prompt. Preserve the reference action structure and product integration.',
      },
    ];

    for (const imageUrl of projectReferenceImageUrls) {
      userContent.push({
        type: 'image_url',
        image_url: { url: imageUrl },
      });
    }

    try {
      const response = await createChatCompletionWithRetry(
        {
          model: config.openRouter.models.pro,
          provider: buildProviderRouting(),
          messages: [
            { role: 'system', content: systemInstructions },
            { role: 'user', content: userContent },
          ],
        },
        'Gemini Moderation Fallback Prompt Rewrite',
        config.openRouter.models.flash
      );

      const rewrittenPrompt = response.data.choices[0]?.message?.content?.trim();
      if (!rewrittenPrompt) {
        throw new Error('Empty moderation fallback prompt result');
      }
      return rewrittenPrompt;
    } catch (error: any) {
      console.error('[GeminiService] Moderation fallback prompt rewrite failed:', error.message);
      throw new Error(`Moderation fallback prompt rewrite failed: ${error.message}`);
    }
  }

  /**
   * Rewrites extracted overlay texts into the project's selected language while preserving timing and layout.
   */
  public static async localizeTextOverlays(input: {
    overlays: ReferenceTextOverlay[];
    project: Project;
    videoAnalysis?: string;
  }): Promise<ReferenceTextOverlay[]> {
    const overlays = input.overlays.filter((overlay) => overlay.text.trim());
    if (!overlays.length) {
      return [];
    }

    const targetLanguage = getProjectLanguageLabel(input.project);
    const payload = overlays.map((overlay, index) => ({
      index,
      text: overlay.text,
      startSeconds: overlay.startSeconds,
      endSeconds: overlay.endSeconds,
      isStatic: Boolean(overlay.isStatic),
    }));

    const systemInstructions = `
      You adapt short on-video text overlays for product Reels.

      TARGET LANGUAGE: ${targetLanguage}

      Rules:
      - Rewrite every overlay text in ${targetLanguage}, regardless of the source language.
      - Preserve the meaning, hook, tone, and commercial intent.
      - Keep each line short enough for a 9:16 mobile video.
      - Preserve line breaks only when they help readability.
      - Do not change timing, order, ids, or layout. Return only text replacements by index.
      - Do not translate brand names, model numbers, product codes, SKUs, @handles, hashtags, or article numbers.
      - Manual project CTA/end-frame text is handled separately, so do not add or invent a CTA here.
      - Return valid JSON only, no markdown.

      Response format:
      {
        "overlays": [
          { "index": 0, "text": "rewritten overlay text" }
        ]
      }
    `;

    try {
      const response = await createChatCompletionWithRetry(
        {
          model: config.openRouter.models.pro,
          provider: buildProviderRouting(),
          messages: [
            { role: 'system', content: systemInstructions },
            {
              role: 'user',
              content: `Project context:
Product: ${input.project.productName || 'Not specified'}
Audience: ${input.project.targetAudience || 'Not specified'}
Description: ${input.project.productDescription || 'Not specified'}
Reference analysis:
${input.videoAnalysis || 'Not provided'}

Overlay texts to rewrite:
${JSON.stringify(payload)}`,
            },
          ],
          response_format: { type: 'json_object' },
        },
        'Gemini Overlay Localization',
        config.openRouter.models.flash
      );

      const content = response.data.choices[0]?.message?.content || '{}';
      const parsed = JSON.parse(extractJsonObject(content));
      const replacements = Array.isArray(parsed?.overlays) ? parsed.overlays : [];
      const replacementByIndex = new Map<number, string>();

      for (const item of replacements) {
        const index = Number(item?.index);
        const text = typeof item?.text === 'string' ? item.text.trim() : '';
        if (Number.isInteger(index) && index >= 0 && text) {
          replacementByIndex.set(index, text);
        }
      }

      return overlays.map((overlay, index) => ({
        ...overlay,
        text: replacementByIndex.get(index) || overlay.text,
      }));
    } catch (error: any) {
      console.error('[GeminiService] Overlay localization failed:', error.message);
      return overlays;
    }
  }

  /**
   * Generates new catchy text overlays for a viral video remix.
   * Based on the original analysis and product context.
   */
  public static async generateRemixTexts(
    input: {
      videoAnalysis: string;
      originalTexts: any[];
      project: Project;
    }
  ): Promise<any[]> {
    const { videoAnalysis, originalTexts, project } = input;
    const languageInstruction = getProjectLanguageInstruction(project);

    const systemInstructions = `
      You are a viral content strategist for TikTok/Reels. 
      Your task is to generate NEW "trigger" captions (text overlays) for a successful video to make it viral again.

      CONTEXT:
      Video Content: ${videoAnalysis}
      Original Captions: ${JSON.stringify(originalTexts.map(t => t.text))}
      Product: ${project.productName}
      Target Audience: ${project.targetAudience}
      CTA: ${project.cta}
      Project Text Language: ${getProjectLanguageLabel(project)}

      RULES:
      1. Create 2-4 text overlays that appear at different times.
      2. Use a "Fresh Hook" — a different angle than the original captions. 
      3. Make them short, punchy, and provocative (trigger curiosity or emotion).
      4. ${languageInstruction}
      5. Output ONLY a JSON array of objects with fields: "text", "startSeconds", "endSeconds".
      6. The total duration should not exceed 10 seconds.
      7. Example: [{"text": "You won't believe this... 😱", "startSeconds": 0, "endSeconds": 3}]
    `;

    try {
      const response = await createChatCompletionWithRetry(
        {
          model: config.openRouter.models.pro,
          provider: buildProviderRouting(),
          messages: [
            { role: 'system', content: systemInstructions },
            { role: 'user', content: 'Generate new viral text overlays for this video.' },
          ],
          response_format: { type: 'json_object' }
        },
        'Gemini Remix Text Generation',
        config.openRouter.models.flash
      );

      const content = response.data.choices[0]?.message?.content || '{}';
      const parsed = JSON.parse(content);
      // Handle different JSON structures from different models
      const overlays = Array.isArray(parsed) ? parsed : (parsed.overlays || parsed.items || []);
      return overlays;
    } catch (error: any) {
      console.error('[GeminiService] Remix text generation failed:', error.message);
      return []; // Fallback to empty if AI fails
    }
  }

  /**
   * Generates a creative remix of an existing prompt.
   * Encourages variations in camera angles, lighting, or specific micro-actions.
   */
  public static async generateRemixPrompt(
    input: {
      originalPrompt: string;
      videoAnalysis: string;
      project: Project;
      projectReferenceImageUrls?: string[];
    }
  ): Promise<string> {
    const { originalPrompt, videoAnalysis, project, projectReferenceImageUrls = [] } = input;

    const systemInstructions = `
      You are an expert video director. You are given a successful video prompt and its original analysis.
      Your task is to create a "REMIX" — a creative variation of the same scene that keeps the CORE PRODUCT and HOOK but changes the visual execution to keep the content fresh.

      DIRECTIONS FOR REMIXING:
      1. Keep the product (@image1) and the main subject context identical.
      2. Vary the Camera: If the original was a medium shot, try a close-up or a tracking shot. Change the lens (e.g., from 35mm to 50mm).
      3. Vary the Lighting: Change the time of day or light source (e.g., from natural daylight to sunset glow or volumetric indoor lighting).
      4. Vary the Micro-Actions: If the character was smiling, make them look surprised or deeply focused. Change small hand movements or background details.
      5. Keep the total duration and structure similar to the original.
      6. ABSOLUTELY NO TEXT in the video.

      ORIGINAL PROMPT FOR REFERENCE:
      ${originalPrompt}

      ORIGINAL VIDEO ANALYSIS:
      ${videoAnalysis}

      PROJECT CONTEXT:
      Product: ${project.productName}
      CTA: ${project.cta}
      Audience: ${project.targetAudience}

      OUTPUT:
      Return only the new timestamped prompt.
    `;

    try {
      const response = await createChatCompletionWithRetry(
        {
          model: config.openRouter.models.pro,
          provider: buildProviderRouting(),
          messages: [
            { role: 'system', content: systemInstructions },
            { 
              role: 'user', 
              content: [
                { type: 'text', text: 'Generate a creative REMIX of the provided video prompt. Keep it visual and action-based.' },
                ...projectReferenceImageUrls.map(url => ({ type: 'image_url' as const, image_url: { url } }))
              ] 
            },
          ],
        },
        'Gemini Remix Generation',
        config.openRouter.models.flash
      );

      return response.data.choices[0]?.message?.content || '';
    } catch (error: any) {
      console.error('[GeminiService] Remix generation failed:', error.message);
      throw new Error(`Remix generation failed: ${error.message}`);
    }
  }
}
