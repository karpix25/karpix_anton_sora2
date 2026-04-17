import { Telegraf, Context, Markup, Input } from 'telegraf';
import { message } from 'telegraf/filters';
import fs from 'fs-extra';
import { config } from '../config.js';
import { InstagramService, InstagramParseError } from '../services/instagram.service.js';
import { GeminiService } from '../services/gemini.service.js';
import { ManualGenerationService } from '../services/manual-generation.service.js';
import { ReferenceAudioService } from '../services/reference-audio.service.js';
import { TextOverlayService } from '../services/text-overlay.service.js';
import { generationTaskStore } from '../storage/generation-task-store.js';
import { projectStore } from '../storage/project-store.js';
import { referenceLibraryStore } from '../storage/reference-library-store.js';

const repeatGenerationCallbackPrefix = 'repeat_generation:';

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function getWebInterfaceUrl(projectId = ''): string {
  const configured = normalizeString(config.web.publicUrl);
  const host = config.web.host === '0.0.0.0' || config.web.host === '::'
    ? 'localhost'
    : config.web.host;
  const base = configured || `http://${host}:${config.web.port}`;

  if (!projectId) {
    return base;
  }

  try {
    const url = new URL(base);
    url.searchParams.set('projectId', projectId);
    return url.toString();
  } catch {
    return `${base}?projectId=${encodeURIComponent(projectId)}`;
  }
}

function getMessageThreadId(ctx: Context): string {
  const messageThreadId =
    ('message' in ctx && ctx.message && 'message_thread_id' in ctx.message
      ? ctx.message.message_thread_id
      : undefined) ??
    getCallbackQueryMessage(ctx)?.message_thread_id;

  return typeof messageThreadId === 'number' ? String(messageThreadId) : 'main';
}

function getCallbackQueryMessage(ctx: Context): any {
  if (!('callbackQuery' in ctx) || !ctx.callbackQuery || !('message' in ctx.callbackQuery)) {
    return undefined;
  }

  return (ctx.callbackQuery as any).message;
}

function extractTopicNameFromContext(ctx: Context, fallback = ''): string {
  const explicitName = normalizeString(fallback);
  if (explicitName) {
    return explicitName;
  }

  const message = 'message' in ctx ? (ctx.message as any) : null;
  const inferredName =
    normalizeString(message?.forum_topic_created?.name) ||
    normalizeString(message?.forum_topic_edited?.name) ||
    normalizeString(message?.reply_to_message?.forum_topic_created?.name) ||
    normalizeString(message?.reply_to_message?.forum_topic_edited?.name);

  return inferredName;
}

function buildDefaultProjectName(messageThreadId: string, topicName = ''): string {
  if (topicName) {
    return topicName;
  }

  const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  return `Project ${messageThreadId} ${timestamp}`;
}

async function getBoundProject(ctx: Context) {
  if (!ctx.chat) {
    return null;
  }

  return projectStore.findProjectByTelegramBinding(String(ctx.chat.id), getMessageThreadId(ctx));
}

function getReplyParams(ctx: Context): { reply_parameters?: { message_id: number } } {
  const message = 'message' in ctx ? (ctx.message as any) : undefined;
  const callbackMessage = getCallbackQueryMessage(ctx);
  const messageId =
    typeof message?.message_id === 'number'
      ? message.message_id
      : callbackMessage?.message_id;
  if (typeof messageId === 'number') {
    return { reply_parameters: { message_id: messageId } };
  }
  return {};
}

function getRepeatGenerationCallbackData(taskId: string): string {
  return `${repeatGenerationCallbackPrefix}${taskId}`;
}

async function sendGenerationResultVideo(
  ctx: Context,
  input: {
    taskId: string;
    videoUrl: string;
    targetModel: string;
    generationProvider: string;
    referenceUrl: string;
    replyParams?: { reply_parameters?: { message_id: number } };
  }
): Promise<void> {
  await ctx.replyWithVideo(input.videoUrl, {
    caption:
      `✨ Сгенерировано через ${input.targetModel.toUpperCase()} (${input.generationProvider})\n\n` +
      `Референс: ${input.referenceUrl}`,
    ...input.replyParams,
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🔁 Повторить', getRepeatGenerationCallbackData(input.taskId))],
    ]),
  });
}

export const bot = new Telegraf(config.telegram.token, {
  handlerTimeout: config.telegram.handlerTimeoutMs,
});

bot.catch((error: unknown, ctx) => {
  const updateId = (ctx.update as any)?.update_id;
  const messageThreadId = getMessageThreadId(ctx);

  console.error('[Bot] Unhandled Telegraf error:', {
    updateId,
    chatId: ctx.chat?.id ? String(ctx.chat.id) : '',
    messageThreadId,
    error: error instanceof Error ? error.message : String(error),
  });
});

// Welcome
bot.start((ctx) => {
  const webUrl = getWebInterfaceUrl();
  ctx.reply(
    'Привет. Этот бот работает с проектами, привязанными к Telegram-темам.\n\n' +
    'Быстрый старт:\n' +
    '1. В нужной теме: /create_project <название>\n' +
    '2. Откройте проект в вебе и заполните фото/настройки.\n' +
    '3. В эту же тему отправляйте ссылку на Instagram Reel.\n\n' +
    `Веб-интерфейс: ${webUrl}`,
    Markup.keyboard([['/create_project', '/project_status'], ['/settings']]).resize()
  );
});

// Settings
bot.command('settings', async (ctx) => {
  if (!ctx.chat) {
    return;
  }

  const boundProject = await getBoundProject(ctx);
  const webUrl = getWebInterfaceUrl(boundProject?.id || '');

  await ctx.reply(
    boundProject
      ? `Настройки проекта "${boundProject.name}" изменяются только в веб-интерфейсе:\n${webUrl}`
      : `Настройки и фото проекта изменяются только в веб-интерфейсе:\n${webUrl}`
  );
});

bot.command('bind_project', async (ctx) => {
  if (!ctx.chat || !('text' in ctx.message)) {
    return;
  }

  const text = ctx.message.text.trim();
  const bindMatch = text.match(/^\/bind_project(?:@\w+)?\s+(\S+)(?:\s+([\s\S]+))?$/);
  const projectId = normalizeString(bindMatch?.[1]);
  const topicNameFromCommand = normalizeString(bindMatch?.[2]);
  const messageThreadId = getMessageThreadId(ctx);

  if (messageThreadId === 'main') {
    await ctx.reply('❗ Отправьте /bind_project внутри конкретной темы, которая должна представлять проект.');
    return;
  }

  if (!projectId) {
    await ctx.reply('⚠️ Использование: /bind_project <project-id> [название темы]');
    return;
  }

  // Check if topic is already busy
  const existingTopicProject = await projectStore.findProjectByTelegramBinding(String(ctx.chat.id), messageThreadId);
  if (existingTopicProject) {
    if (existingTopicProject.id === projectId) {
      await ctx.reply(`ℹ️ Проект "${existingTopicProject.name}" уже привязан к этой теме.`);
      return;
    }
    await ctx.reply(`❌ Эта тема уже занята проектом "${existingTopicProject.name}" (ID: ${existingTopicProject.id}).\n\nИспользуйте другую тему или удалите старый проект.`);
    return;
  }

  // Check if target project is already bound elsewhere
  const targetProject = await projectStore.getProject(projectId);
  if (!targetProject) {
    await ctx.reply(`❌ Проект не найден: ${projectId}`);
    return;
  }

  if (targetProject.telegramChatId && targetProject.telegramTopicId) {
    await ctx.reply(
      `❌ Проект "${targetProject.name}" уже привязан к теме "${targetProject.telegramTopicName || targetProject.telegramTopicId}" в чате ${targetProject.telegramChatId}.\n\n` +
      `Один проект нельзя привязывать к нескольким темам.`
    );
    return;
  }

  const inferredTopicName = extractTopicNameFromContext(ctx, topicNameFromCommand) || `Тема ${messageThreadId}`;
  const project = await projectStore.bindProjectToTelegramTopic(
    projectId,
    String(ctx.chat.id),
    messageThreadId,
    inferredTopicName
  );

  if (!project) {
    await ctx.reply(`❌ Не удалось привязать проект.`);
    return;
  }

  await ctx.reply(
    `✅ Проект привязан к этой теме.\n\n` +
    `Проект: ${project.name}\n` +
    `Chat ID: ${project.telegramChatId}\n` +
    `Тема: ${project.telegramTopicName || '(без названия)'}\n` +
    `Topic ID: ${project.telegramTopicId}\n\n` +
    `Открыть проект в вебе: ${getWebInterfaceUrl(project.id)}`
  );
});

bot.command('bind_topic', async (ctx) => {
  if (!ctx.chat || !('text' in ctx.message)) {
    return;
  }

  const text = ctx.message.text.trim();
  const bindMatch = text.match(/^\/bind_topic(?:@\w+)?\s+(\S+)\s+(\d+)(?:\s+([\s\S]+))?$/);
  const projectId = normalizeString(bindMatch?.[1]);
  const topicId = normalizeString(bindMatch?.[2]);
  const topicName = normalizeString(bindMatch?.[3]);

  if (!projectId || !topicId) {
    await ctx.reply('⚠️ Использование: /bind_topic <project-id> <topic-id> [название темы]');
    return;
  }

  // Check if target topic is already busy
  const existingTopicProject = await projectStore.findProjectByTelegramBinding(String(ctx.chat.id), topicId);
  if (existingTopicProject) {
    if (existingTopicProject.id === projectId) {
      await ctx.reply(`ℹ️ Проект "${existingTopicProject.name}" уже привязан к теме ${topicId}.`);
      return;
    }
    await ctx.reply(`❌ Тема ${topicId} уже занята проектом "${existingTopicProject.name}" (ID: ${existingTopicProject.id}).`);
    return;
  }

  // Check if target project is already bound elsewhere
  const targetProject = await projectStore.getProject(projectId);
  if (!targetProject) {
    await ctx.reply(`❌ Проект не найден: ${projectId}`);
    return;
  }

  if (targetProject.telegramChatId && targetProject.telegramTopicId) {
    await ctx.reply(`❌ Проект "${targetProject.name}" уже привязан к теме ${targetProject.telegramTopicId} в чате ${targetProject.telegramChatId}.`);
    return;
  }

  const inferredTopicName = topicName || `Тема ${topicId}`;
  const project = await projectStore.bindProjectToTelegramTopic(
    projectId,
    String(ctx.chat.id),
    topicId,
    inferredTopicName
  );

  if (!project) {
    await ctx.reply(`❌ Не удалось привязать проект.`);
    return;
  }

  await ctx.reply(
    `✅ Проект "${project.name}" привязан.\n` +
    `Chat ID: ${project.telegramChatId}\n` +
    `Тема: ${project.telegramTopicName || '(без названия)'}\n` +
    `Topic ID: ${project.telegramTopicId}\n\n` +
    `Открыть проект в вебе: ${getWebInterfaceUrl(project.id)}`
  );
});

bot.command('create_project', async (ctx) => {
  if (!ctx.chat || !('text' in ctx.message)) {
    return;
  }

  const text = ctx.message.text.trim();
  const match = text.match(/^\/create_project(?:@\w+)?(?:\s+([\s\S]+))?$/);
  const rawArgs = normalizeString(match?.[1]);
  const messageThreadId = getMessageThreadId(ctx);

  const argParts = rawArgs ? rawArgs.split(/\s+/).filter(Boolean) : [];
  let explicitTopicId = '';
  if (argParts.length > 1) {
    const tail = argParts[argParts.length - 1];
    if (tail && /^\d+$/.test(tail)) {
      explicitTopicId = tail;
      argParts.pop();
    }
  }

  const topicId = explicitTopicId || (messageThreadId !== 'main' ? messageThreadId : '');
  if (!topicId) {
    await ctx.reply(
      '❗ Создание с привязкой требует topic_id.\n' +
      'Запустите команду в нужной теме или укажите ID:\n' +
      '/create_project <название проекта> <topic-id>'
    );
    return;
  }

  // Check if topic is already busy
  const existingTopicProject = await projectStore.findProjectByTelegramBinding(String(ctx.chat.id), topicId);
  if (existingTopicProject) {
    await ctx.reply(`❌ В этой теме уже есть проект: "${existingTopicProject.name}" (ID: ${existingTopicProject.id}).\n\nНельзя создать второй проект в одной и той же теме.`);
    return;
  }

  const inferredTopicName = messageThreadId === topicId
    ? extractTopicNameFromContext(ctx)
    : '';
  const projectName = normalizeString(argParts.join(' ')) || buildDefaultProjectName(topicId, inferredTopicName);

  const created = await projectStore.createProject({
    name: projectName,
    mode: 'manual',
    selectedModel: 'sora-2',
    automationEnabled: false,
    dailyGenerationLimit: 1,
    isActive: true,
  });

  const bound = await projectStore.bindProjectToTelegramTopic(
    created.id,
    String(ctx.chat.id),
    topicId,
    inferredTopicName || `Тема ${topicId}`
  );

  if (!bound) {
    await ctx.reply('❌ Не удалось привязать созданный проект к теме.');
    return;
  }

  await ctx.reply(
    `✅ Проект создан и привязан.\n\n` +
    `Проект: ${bound.name}\n` +
    `ID: ${bound.id}\n` +
    `Chat ID: ${bound.telegramChatId}\n` +
    `Topic ID: ${bound.telegramTopicId}\n\n` +
    `Дальше заполните фото и настройки в веб-интерфейсе:\n${getWebInterfaceUrl(bound.id)}`
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
      `Создайте проект в этой теме: /create_project <название>\n` +
      `Или привяжите существующий: /bind_project <project-id>\n\n` +
      `Веб-интерфейс: ${getWebInterfaceUrl()}`
    );
    return;
  }

  await ctx.reply(
    `Текущая тема привязана к:\n\n` +
    `Проект: ${project.name}\n` +
    `Chat ID: ${project.telegramChatId}\n` +
    `Тема: ${project.telegramTopicName || '(без названия)'}\n` +
    `Topic ID: ${project.telegramTopicId}\n` +
    `Модель: ${project.selectedModel.toUpperCase()}\n` +
    `Режим: ${project.mode === 'auto' ? 'авто' : 'ручной'}\n\n` +
    `Веб: ${getWebInterfaceUrl(project.id)}`
  );
});

bot.action(/^repeat_generation:(.+)$/, async (ctx) => {
  const taskId = normalizeString((ctx as any).match?.[1]);

  if (!ctx.chat || !taskId) {
    await ctx.answerCbQuery('Не удалось определить задачу для повтора.', { show_alert: true }).catch(() => {});
    return;
  }

  const replyParams = getReplyParams(ctx);
  let statusMsg: any = null;

  try {
    const sourceTask = await generationTaskStore.getTask(taskId);
    if (!sourceTask) {
      await ctx.answerCbQuery('Исходная генерация не найдена.', { show_alert: true }).catch(() => {});
      return;
    }

    if (!sourceTask.promptText) {
      await ctx.answerCbQuery('У исходной генерации нет сохранённого промпта.', { show_alert: true }).catch(() => {});
      return;
    }

    const sourceProject = await projectStore.getProject(sourceTask.projectId);
    if (!sourceProject) {
      await ctx.answerCbQuery('Проект исходной генерации не найден.', { show_alert: true }).catch(() => {});
      return;
    }

    const currentChatId = String(ctx.chat.id);
    const currentThreadId = getMessageThreadId(ctx);
    if (sourceProject.telegramChatId !== currentChatId || sourceProject.telegramTopicId !== currentThreadId) {
      await ctx.answerCbQuery('Эта кнопка относится к другому проекту или теме.', { show_alert: true }).catch(() => {});
      return;
    }

    await ctx.answerCbQuery('Запускаю повторную генерацию...').catch(() => {});
    statusMsg = await ctx.reply('⏳ Повторяю генерацию по сохранённому промпту...', replyParams);

    const repeatedTask = await ManualGenerationService.runFromLibraryItem({
      projectId: sourceTask.projectId,
      referenceLibraryItemId: sourceTask.referenceLibraryItemId,
      triggerMode: 'telegram_manual',
      promptText: sourceTask.promptText,
    });
    if (!repeatedTask?.resultVideoUrl) {
      throw new Error('Generation completed without a result video URL');
    }

    const sourceLibraryItem = await referenceLibraryStore.getItem(repeatedTask.referenceLibraryItemId);
    const finalVideoUrl = repeatedTask.yandexDownloadUrl || repeatedTask.resultVideoUrl;
    const generationProvider = (repeatedTask.provider || 'kie').toUpperCase();

    if (statusMsg) {
      await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    }

    await sendGenerationResultVideo(ctx, {
      taskId: repeatedTask.id,
      videoUrl: finalVideoUrl,
      targetModel: repeatedTask.targetModel,
      generationProvider,
      referenceUrl: sourceLibraryItem?.sourceUrl || '(не указан)',
      replyParams,
    });
  } catch (error: any) {
    const errorText = `❌ Ошибка повторной генерации: ${error?.message || String(error)}`;
    if (statusMsg) {
      await ctx.telegram
        .editMessageText(ctx.chat.id, statusMsg.message_id, undefined, errorText)
        .catch(() => ctx.reply(errorText, replyParams).catch(() => {}));
    } else {
      await ctx.reply(errorText, replyParams).catch(() => {});
    }
  }
});

// Handle Photo
bot.on(message('photo'), async (ctx) => {
  const boundProject = await getBoundProject(ctx);
  await ctx.reply(
    `Фото через Telegram отключены для стабильного пайплайна.\n` +
    `Загрузите референсы в веб-интерфейсе:\n${getWebInterfaceUrl(boundProject?.id || '')}`,
    getReplyParams(ctx)
  );
});

// Handle Instagram Link
bot.on(message('text'), async (ctx) => {
  try {
    if (!ctx.chat) return;
    const text = ctx.message.text;
    if (text.startsWith('/')) return; // Ignore commands
    const replyParams = getReplyParams(ctx);

    // Basic Instagram URL check
    if (!text.includes('instagram.com/')) {
      return ctx.reply('⚠️ Отправьте корректную ссылку на Instagram Reel или фото товара.', replyParams);
    }

    const reelUrl = text.trim();

    const boundProject = await getBoundProject(ctx);
    if (!boundProject) {
      await ctx.reply(
        `Эта тема не привязана к проекту.\n` +
        `Создайте проект: /create_project <название>\n` +
        `Или привяжите существующий: /bind_project <project-id>\n\n` +
        `Веб-интерфейс: ${getWebInterfaceUrl()}`,
        replyParams
      );
      return;
    }

    if (!boundProject.referenceImages.length) {
      await ctx.reply(
        `У проекта "${boundProject.name}" нет фото-референсов.\n` +
        `Загрузите фото в веб-интерфейсе и повторите:\n${getWebInterfaceUrl(boundProject.id)}`,
        replyParams
      );
      return;
    }

    const targetModel = boundProject.selectedModel;
    const libraryItem = await referenceLibraryStore.createItem({
      projectId: boundProject.id,
      sourceUrl: reelUrl,
      status: 'received',
    });

    let statusMsg: any = null;
    const chatId = ctx.chat.id;
    let analysisSaved = false;

    const updateStatus = async (text: string) => {
      try {
        if (statusMsg) {
          await ctx.telegram.editMessageText(chatId, statusMsg.message_id, undefined, text);
        } else {
          statusMsg = await ctx.reply(text, replyParams);
        }
      } catch (err: any) {
        console.error(`[Bot] Failed to update status to "${text}":`, err.message);
        // If editing fails, try a new reply
        try {
          statusMsg = await ctx.reply(text, replyParams);
        } catch (innerErr) {
          console.error('[Bot] Critical failure: could not even send a fresh status reply.');
        }
      }
    };

    let videoLocalPath: string | null = null;

    try {
      // 1. Parsing Instagram Reel
      await updateStatus('⏳ Разбираю Reel...');
      await referenceLibraryStore.updateItem(libraryItem.id, { status: 'parsing' });
      const reel = await InstagramService.getReelInfo(reelUrl);

      // 2. Download Video for Base64 Analysis
      await updateStatus('⏳ Скачиваю видео для стабильного анализа...');
      videoLocalPath = await InstagramService.downloadVideo(reel.url);

      // 3. Analyzing Video
      await updateStatus('⏳ Анализирую стиль через Gemini...');
      const updatedLibraryItem = await referenceLibraryStore.updateItem(libraryItem.id, {
        directVideoUrl: reel.url,
        thumbnailUrl: reel.thumbnail ?? '',
        status: 'analyzing',
      });
      if (!updatedLibraryItem) {
        throw new Error('Не удалось обновить элемент библиотеки после парсинга Reel');
      }

      await updateStatus('⏳ Сохраняю аудио из Reel...');
      await ReferenceAudioService.ensureAudioTrack(updatedLibraryItem);
      await updateStatus('⏳ Анализирую стиль через Gemini...');

      const analysis = await GeminiService.analyzeVideo({ localPath: videoLocalPath, videoUrl: reel.url });
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

      await updateStatus('⏳ Собираю промпт и запускаю генерацию видео...');
      const generationTask = await ManualGenerationService.runFromLibraryItem({
        projectId: boundProject.id,
        referenceLibraryItemId: libraryItem.id,
        triggerMode: 'telegram_manual',
      });
      if (!generationTask?.resultVideoUrl) {
        throw new Error('Generation completed without a result video URL');
      }

      const finalVideoUrl = generationTask.yandexDownloadUrl || generationTask.resultVideoUrl;
      const generationProvider = (generationTask.provider || 'kie').toUpperCase();

      // 6. Send Result
      if (statusMsg) {
        await ctx.telegram.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      }
      await sendGenerationResultVideo(ctx, {
        taskId: generationTask.id,
        videoUrl: finalVideoUrl,
        targetModel,
        generationProvider,
        referenceUrl: reelUrl,
        replyParams,
      });
    } catch (error: any) {
      const errorMsg = error.message || String(error) || 'Unknown error';
      console.error('Process Error details:', error);
      
      if (!analysisSaved) {
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
          ctx.reply(errorText, replyParams).catch(() => {});
        });
      } else {
        await ctx.reply(errorText, replyParams).catch(() => {});
      }

      if (isInstagramParseError && error.debugFilePath) {
        await ctx.replyWithDocument(Input.fromLocalFile(error.debugFilePath), {
          caption: 'Полный JSON-ответ RapidAPI для этого Reel.',
          ...replyParams,
        });
      }
    } finally {
      if (videoLocalPath) {
        fs.remove(videoLocalPath).catch((err) => {
          console.error(`[Bot] Failed to cleanup temp video ${videoLocalPath}:`, err.message);
        });
      }
    }
  } catch (error: any) {
    const updateId = (ctx.update as any)?.update_id;
    const messageThreadId = getMessageThreadId(ctx);

    console.error('[Bot] Unhandled text handler error:', {
      updateId,
      chatId: ctx.chat?.id ? String(ctx.chat.id) : '',
      messageThreadId,
      error: error?.message || String(error),
    });

    await ctx.reply('❌ Внутренняя ошибка обработки сообщения. Попробуйте еще раз.', getReplyParams(ctx)).catch(() => {});
  }
});
