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
