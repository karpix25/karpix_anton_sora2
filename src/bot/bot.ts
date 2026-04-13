import { Telegraf, Context, Markup, Input } from 'telegraf';
import { message } from 'telegraf/filters';
import fs from 'fs-extra';
import { config } from '../config.js';
import { InstagramService, InstagramParseError } from '../services/instagram.service.js';
import { GeminiService } from '../services/gemini.service.js';
import { ManualGenerationService } from '../services/manual-generation.service.js';
import { ReferenceAudioService } from '../services/reference-audio.service.js';
import { TextOverlayService } from '../services/text-overlay.service.js';
import { VideoGenerationService } from '../services/video-generation.service.js';
import { projectStore } from '../storage/project-store.js';
import { referenceLibraryStore } from '../storage/reference-library-store.js';

interface Session {
  lastPhotoUrl?: string;
  model: 'sora-2' | 'veo-3-1';
}

// Memory-based session (use a DB like Redis for production)
const sessions = new Map<string, Session>();

function getMessageThreadId(ctx: Context): string {
  const messageThreadId = 'message' in ctx && ctx.message && 'message_thread_id' in ctx.message
    ? ctx.message.message_thread_id
    : undefined;

  return typeof messageThreadId === 'number' ? String(messageThreadId) : 'main';
}

function getSessionKey(ctx: Context): string {
  const chatId = ctx.chat?.id ? String(ctx.chat.id) : 'unknown-chat';
  const messageThreadId = getMessageThreadId(ctx);
  return `${chatId}:${messageThreadId}`;
}

function getSession(ctx: Context): Session {
  const sessionKey = getSessionKey(ctx);

  if (!sessions.has(sessionKey)) {
    sessions.set(sessionKey, { model: 'sora-2' });
  }

  return sessions.get(sessionKey)!;
}

async function getBoundProject(ctx: Context) {
  if (!ctx.chat) {
    return null;
  }

  return projectStore.findProjectByTelegramBinding(String(ctx.chat.id), getMessageThreadId(ctx));
}

export const bot = new Telegraf(config.telegram.token);

// Welcome
bot.start((ctx) => {
  ctx.reply(
    'Привет. Этот бот автоматизирует генерацию видео через Sora 2 и Veo 3.1.\n\n' +
    '1. Отправьте ФОТО товара.\n' +
    '2. Отправьте ссылку на Instagram REEL.\n' +
    '3. Получите сгенерированное видео.\n\n' +
    'Используйте /settings, чтобы посмотреть текущую модель.',
    Markup.keyboard([['/settings']]).resize()
  );
});

// Settings
bot.command('settings', async (ctx) => {
  if (!ctx.chat) return;
  const boundProject = await getBoundProject(ctx);

  if (boundProject) {
    await ctx.reply(
      `Эта тема привязана к проекту "${boundProject.name}".\n` +
      `Текущая модель: ${boundProject.selectedModel.toUpperCase()}\n\n` +
      `Изменяйте настройки проекта в веб-интерфейсе.`
    );
    return;
  }

  const session = getSession(ctx);
  ctx.reply(
    `Текущая модель: ${session.model.toUpperCase()}\nВыберите модель:`,
    Markup.inlineKeyboard([
      [Markup.button.callback('Sora 2', 'set_model:sora-2')],
      [Markup.button.callback('Veo 3.1', 'set_model:veo-3-1')],
    ])
  );
});

// Handle Model Change
bot.action(/set_model:(.+)/, (ctx) => {
  const model = ctx.match[1] as 'sora-2' | 'veo-3-1';
  if (!ctx.chat) return;
  const session = getSession(ctx);
  session.model = model;
  ctx.answerCbQuery();
  ctx.editMessageText(`Модель установлена: ${model.toUpperCase()}`);
});

bot.command('bind_project', async (ctx) => {
  if (!ctx.chat || !('text' in ctx.message)) {
    return;
  }

  const text = ctx.message.text.trim();
  const [, projectId] = text.split(/\s+/, 2);
  const messageThreadId = getMessageThreadId(ctx);

  if (messageThreadId === 'main') {
    await ctx.reply('❗ Отправьте /bind_project внутри конкретной темы, которая должна представлять проект.');
    return;
  }

  if (!projectId) {
    await ctx.reply('⚠️ Использование: /bind_project <project-id>');
    return;
  }

  const project = await projectStore.bindProjectToTelegramTopic(projectId, String(ctx.chat.id), messageThreadId);
  if (!project) {
    await ctx.reply(`❌ Проект не найден: ${projectId}`);
    return;
  }

  await ctx.reply(
    `✅ Проект привязан к этой теме.\n\n` +
    `Проект: ${project.name}\n` +
    `Chat ID: ${project.telegramChatId}\n` +
    `Topic ID: ${project.telegramTopicId}`
  );
});

bot.command('project_status', async (ctx) => {
  if (!ctx.chat) {
    return;
  }

  const messageThreadId = getMessageThreadId(ctx);
  const project = await getBoundProject(ctx);

  if (!project) {
    await ctx.reply(
      `К этому контексту пока не привязан проект.\n\n` +
      `Chat ID: ${ctx.chat.id}\n` +
      `Topic ID: ${messageThreadId}\n\n` +
      `Используйте /bind_project <project-id> в этой теме.`
    );
    return;
  }

  await ctx.reply(
    `Текущая тема привязана к:\n\n` +
    `Проект: ${project.name}\n` +
    `Chat ID: ${project.telegramChatId}\n` +
    `Topic ID: ${project.telegramTopicId}\n` +
    `Модель: ${project.selectedModel.toUpperCase()}\n` +
    `Режим: ${project.mode === 'auto' ? 'авто' : 'ручной'}`
  );
});

// Handle Photo
bot.on(message('photo'), async (ctx) => {
  try {
    const photo = ctx.message.photo.pop();
    if (!photo || !ctx.chat) return;

    // Get the direct link to the photo from Telegram servers
    const link = await ctx.telegram.getFileLink(photo.file_id);
    const session = getSession(ctx);
    session.lastPhotoUrl = link.href;

    ctx.reply('✅ Фото товара получено. Теперь отправьте ссылку на Instagram Reel, стиль которого нужно взять за основу.');
  } catch (error: any) {
    console.error('Photo Handle Error:', error.message);
    ctx.reply('❌ Не удалось обработать изображение. Попробуйте еще раз.');
  }
});

// Handle Instagram Link
bot.on(message('text'), async (ctx) => {
  if (!ctx.chat) return;
  const text = ctx.message.text;
  if (text.startsWith('/')) return; // Ignore commands

  // Basic Instagram URL check
  if (!text.includes('instagram.com/')) {
    return ctx.reply('⚠️ Отправьте корректную ссылку на Instagram Reel или фото товара.');
  }

  const reelUrl = text.trim();

  const session = getSession(ctx);
  const boundProject = await getBoundProject(ctx);
  const duplicateLibraryItem = boundProject
    ? await referenceLibraryStore.findProjectItemBySourceUrl(boundProject.id, reelUrl)
    : null;
  if (duplicateLibraryItem && boundProject) {
    await ctx.reply(
      `ℹ️ Этот Reel уже есть в проекте "${boundProject.name}".\n` +
      `Статус: ${duplicateLibraryItem.status}.\n` +
      'Повторно не сохраняю.'
    );
    return;
  }

  const targetModel = boundProject?.selectedModel ?? session.model;
  const projectReferenceImageUrls = boundProject
    ? await projectStore.getReferenceImageDataUrls(boundProject.referenceImages)
    : [];
  const libraryItem = boundProject
    ? await referenceLibraryStore.createItem({
        projectId: boundProject.id,
        sourceUrl: reelUrl,
        status: 'received',
      })
    : null;

  if (!boundProject && !session.lastPhotoUrl && projectReferenceImageUrls.length === 0) {
    return ctx.reply(
      boundProject
        ? '❗ У этого проекта пока нет референс-изображений. Загрузите фото товара в веб-интерфейсе или отправьте ФОТО в Telegram.'
        : '❗ Сначала отправьте ФОТО товара, который нужно использовать.'
    );
  }

  let statusMsg: any = null;
  const chatId = ctx.chat.id;
  let analysisSaved = false;

  const updateStatus = async (text: string) => {
    try {
      if (statusMsg) {
        await ctx.telegram.editMessageText(chatId, statusMsg.message_id, undefined, text);
      } else {
        statusMsg = await ctx.reply(text);
      }
    } catch (err: any) {
      console.error(`[Bot] Failed to update status to "${text}":`, err.message);
      // If editing fails, try a new reply
      try {
        statusMsg = await ctx.reply(text);
      } catch (innerErr) {
        console.error('[Bot] Critical failure: could not even send a fresh status reply.');
      }
    }
  };

  let videoLocalPath: string | null = null;

  try {
    // 1. Parsing Instagram Reel
    await updateStatus('⏳ Разбираю Reel...');
    if (libraryItem) {
      await referenceLibraryStore.updateItem(libraryItem.id, { status: 'parsing' });
    }
    const reel = await InstagramService.getReelInfo(reelUrl);

    // 2. Download Video for Base64 Analysis
    await updateStatus('⏳ Скачиваю видео для стабильного анализа...');
    videoLocalPath = await InstagramService.downloadVideo(reel.url);

    // 3. Analyzing Video
    await updateStatus('⏳ Анализирую стиль через Gemini...');
    let updatedLibraryItem = libraryItem;
    if (libraryItem) {
      updatedLibraryItem = await referenceLibraryStore.updateItem(libraryItem.id, {
        directVideoUrl: reel.url,
        thumbnailUrl: reel.thumbnail ?? '',
        status: 'analyzing',
      });
    }

    if (updatedLibraryItem) {
      await updateStatus('⏳ Сохраняю аудио из Reel...');
      await ReferenceAudioService.ensureAudioTrack(updatedLibraryItem);
      await updateStatus('⏳ Анализирую стиль через Gemini...');
    }

    const analysis = await GeminiService.analyzeVideo({ localPath: videoLocalPath, videoUrl: reel.url });
    if (libraryItem) {
      const textOverlays = await TextOverlayService.extractFromVideo({
        localPath: videoLocalPath,
        videoUrl: reel.url,
        analysis,
      });

      await referenceLibraryStore.updateItem(libraryItem.id, {
        directVideoUrl: reel.url,
        thumbnailUrl: reel.thumbnail ?? '',
        textOverlays,
        analysis,
        status: 'analyzed',
        errorMessage: '',
      });
      analysisSaved = true;
    }

    let videoUrl: string;

    if (boundProject && libraryItem) {
      await updateStatus('⏳ Собираю промпт и запускаю генерацию видео...');
      const generationTask = await ManualGenerationService.runFromLibraryItem({
        projectId: boundProject.id,
        referenceLibraryItemId: libraryItem.id,
        triggerMode: 'telegram_manual',
        ...(session.lastPhotoUrl ? { fallbackReferenceImageUrl: session.lastPhotoUrl } : {}),
      });

      if (!generationTask?.resultVideoUrl) {
        throw new Error('Generation completed without a result video URL');
      }

      videoUrl = generationTask.yandexDownloadUrl || generationTask.resultVideoUrl;
    } else {
      // 3. Generating Sora Prompt
      await updateStatus('⏳ Собираю промпт через Gemini...');
      const promptInput = {
        videoAnalysis: analysis,
        targetModel,
        project: boundProject,
        projectReferenceImageUrls,
        ...(session.lastPhotoUrl ? { fallbackProductPhotoUrl: session.lastPhotoUrl } : {}),
      };
      const prompt = await GeminiService.generateClonningPrompt(promptInput);

      // 4. Triggering Generation
      await updateStatus(`⏳ Запускаю генерацию ${targetModel.toUpperCase()}... Это может занять несколько минут.`);
      const generationReferenceImageUrl = session.lastPhotoUrl || projectReferenceImageUrls[0];
      if (!generationReferenceImageUrl) {
        throw new Error('No product reference image available for generation');
      }

      const generationResult = await VideoGenerationService.generateWithFallback({
        prompt,
        imageUrl: generationReferenceImageUrl,
        model: targetModel,
      });

      // 5. Polling Result
      videoUrl = generationResult.resultVideoUrl;
    }

    // 6. Send Result
    if (statusMsg) {
      await ctx.telegram.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    }
    await ctx.replyWithVideo(videoUrl, {
      caption: `✨ Сгенерировано через ${targetModel.toUpperCase()}\n\nРеференс: ${reelUrl}`,
    });

  } catch (error: any) {
    const errorMsg = error.message || String(error) || 'Unknown error';
    console.error('Process Error details:', error);
    
    if (libraryItem && !analysisSaved) {
      await referenceLibraryStore.updateItem(libraryItem.id, {
        status: 'failed',
        errorMessage: errorMsg,
      });
    }

    const isInstagramParseError = error instanceof InstagramParseError;
    const errorText = isInstagramParseError
      ? `❌ Ошибка обработки: ${errorMsg}\n\nПолный ответ RapidAPI приложен файлом.`
      : analysisSaved
        ? `❌ Ошибка генерации: ${errorMsg}\n\nСсылка на Reel и его анализ уже сохранены в библиотеке проекта.`
        : `❌ Ошибка обработки: ${errorMsg}`;

    if (statusMsg) {
      await ctx.telegram.editMessageText(chatId, statusMsg.message_id, undefined, errorText).catch(() => {
        ctx.reply(errorText).catch(() => {});
      });
    } else {
      await ctx.reply(errorText).catch(() => {});
    }

    if (isInstagramParseError && error.debugFilePath) {
      await ctx.replyWithDocument(Input.fromLocalFile(error.debugFilePath), {
        caption: 'Полный JSON-ответ RapidAPI для этого Reel.',
      });
    }
  } finally {
    if (videoLocalPath) {
      fs.remove(videoLocalPath).catch((err) => {
        console.error(`[Bot] Failed to cleanup temp video ${videoLocalPath}:`, err.message);
      });
    }
  }
});
