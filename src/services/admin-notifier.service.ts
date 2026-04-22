import { bot } from '../bot/bot.js';
import { config } from '../config.js';

export class AdminNotifierService {
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
   */
  public static translateError(errorContent: string): string {
    const lowercase = errorContent.toLowerCase();

    if (
      lowercase.includes('insufficient') || 
      lowercase.includes('balance') || 
      lowercase.includes('credits') ||
      lowercase.includes('not enough funds')
    ) {
      return '❌ Недостаточно средств на балансе провайдера. Пожалуйста, пополните счет.';
    }

    if (lowercase.includes('limit') || lowercase.includes('rate limit') || lowercase.includes('too many requests')) {
      return '⏳ Исчерпан лимит запросов к сервису. Попробуйте позже.';
    }

    if (lowercase.includes('invalid') && (lowercase.includes('token') || lowercase.includes('key'))) {
      return '🔑 Ошибка авторизации: неверный API-ключ или токен.';
    }

    if (lowercase.includes('timeout') || lowercase.includes('timed out')) {
      return '⏱ Превышено время ожидания ответа от сервиса.';
    }

    if (lowercase.includes('disk') && (lowercase.includes('full') || lowercase.includes('space') || lowercase.includes('507'))) {
      return '💾 Недостаточно места на Яндекс Диске для сохранения видео.';
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
      `⚠️ <i>Генерация видео может быть остановлена до пополнения средств.</i>`;

    await this.sendAlert(message);
  }
}
