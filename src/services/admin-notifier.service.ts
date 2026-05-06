import { bot } from '../bot/bot.js';
import { config } from '../config.js';

export class AdminNotifierService {
  private static getTrackingTokenFromDiskPath(diskPath: string): string {
    const normalized = String(diskPath || '').trim();
    if (!normalized) {
      return '';
    }

    const fileName = normalized.split('/').filter(Boolean).pop() || '';
    return fileName.replace(/\.[A-Za-z0-9]+$/, '');
  }

  /**
   * Sends an alert to all configured administrators.
   */
  public static async sendAlert(message: string): Promise<void> {
    const adminIds = config.telegram.adminIds;
    if (!adminIds.length) {
      console.warn('[AdminNotifierService] No admin IDs configured. Alert was not sent:', message);
      return;
    }

    console.log(`[AdminNotifierService] Sending alert to ${adminIds.length} admins...`);

    const sendPromises = adminIds.map(async (id) => {
      try {
        await bot.telegram.sendMessage(id, message, {
          parse_mode: 'HTML',
        });
      } catch (error: any) {
        console.error(`[AdminNotifierService] Failed to send alert to ${id}:`, error.message);
      }
    });

    await Promise.all(sendPromises);
  }

  /**
   * Translates common technical errors into human-readable Russian.
   * Now includes provider identification for better clarity.
   */
  public static translateError(errorContent: string, explicitProvider?: string): string {
    const lowercase = errorContent.toLowerCase();
    
    // Try to extract provider from string if not provided (e.g. "(WaveSpeed)" or "(Kie)")
    let provider = explicitProvider;
    if (!provider) {
      const match = errorContent.match(/\(([^)]+)\)/);
      if (match) {
        provider = match[1];
      }
    }

    const providerSuffix = provider ? ` (${provider})` : '';

    if (
      lowercase.includes('insufficient') || 
      lowercase.includes('balance') || 
      lowercase.includes('credits') ||
      lowercase.includes('not enough funds')
    ) {
      return `❌ Недостаточно средств на балансе провайдера${providerSuffix}. Пожалуйста, пополните счет.`;
    }

    if (lowercase.includes('limit') || lowercase.includes('rate limit') || lowercase.includes('too many requests')) {
      return `⏳ Исчерпан лимит запросов к сервису${providerSuffix}. Попробуйте позже.`;
    }

    if (lowercase.includes('invalid') && (lowercase.includes('token') || lowercase.includes('key'))) {
      return `🔑 Ошибка авторизации${providerSuffix}: неверный API-ключ или токен.`;
    }

    if (lowercase.includes('timeout') || lowercase.includes('timed out')) {
      return `⏱ Превышено время ожидания ответа от сервиса${providerSuffix}.`;
    }

    if (lowercase.includes('disk') && (lowercase.includes('full') || lowercase.includes('space') || lowercase.includes('507'))) {
      const diskLabel = provider || 'Яндекс Диск';
      return `💾 Недостаточно места на ${diskLabel} для сохранения видео.`;
    }

    return errorContent; // Return original if unknown
  }

  /**
   * Specifically handles balance/credit exhaustion errors.
   */
  public static async notifyBalanceError(providerName: string, errorDetails: string): Promise<void> {
    const timestamp = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    const message = 
      `🚨 <b>КРИТИЧЕСКАЯ ОШИБКА БАЛАНСА</b>\n\n` +
      `<b>Провайдер:</b> ${providerName}\n` +
      `<b>Время:</b> ${timestamp} MSK\n\n` +
      `<b>Детали:</b>\n<code>${errorDetails}</code>\n\n` +
      `❗ <b>Нужно пополнить баланс в ${providerName}.</b>\n\n` +
      `⚠️ <i>Генерация видео может быть остановлена до пополнения средств.</i>`;
    await this.sendAlert(message);
  }

  /**
   * Sends a generated video to the associated Telegram project topic.
   */
  public static async sendVideoToProject(project: any, task: any): Promise<void> {
    if (!project.telegramChatId || !project.telegramTopicId) {
      console.warn(`[AdminNotifierService] Project ${project.id} not bound to Telegram. Notification skipped.`);
      return;
    }

    const videoUrl = task.yandexDownloadUrl || task.resultVideoUrl;
    if (!videoUrl) return;
    const trackingToken = this.getTrackingTokenFromDiskPath(task.yandexDiskPath);

    const caption = 
      `✨ <b>Видео готово!</b> (Восстановлено)\n\n` +
      `<b>Модель:</b> ${task.targetModel.toUpperCase()}\n` +
      `<b>Провайдер:</b> ${(task.provider || 'unknown').toUpperCase()}\n` +
      `${trackingToken ? `<b>Тег:</b> #${trackingToken}\n` : ''}` +
      `<b>ID задачи:</b> <code>${task.id}</code>\n\n` +
      `<i>Этот ролик был автоматически завершен после перезапуска сервера.</i>`;

    const options: any = {
      caption,
      parse_mode: 'HTML',
    };
    
    if (project.telegramTopicId && project.telegramTopicId !== 'main') {
      options.message_thread_id = Number(project.telegramTopicId);
    }

    try {
      await bot.telegram.sendVideo(project.telegramChatId, videoUrl, options);
      console.log(`[AdminNotifierService] Result video sent to project ${project.id} in Telegram.`);
    } catch (error: any) {
      console.error(`[AdminNotifierService] Failed to send video to Telegram for project ${project.id}:`, error.message);
    }
  }
}
