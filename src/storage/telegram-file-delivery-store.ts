import { randomUUID } from 'node:crypto';
import { query } from './db.js';

export type TelegramFileKind = 'generated_video' | 'reference_image' | 'document' | 'video';

export interface TelegramFileDeliveryInput {
  projectId?: string;
  projectName?: string;
  taskId?: string;
  referenceLibraryItemId?: string;
  fileKind: TelegramFileKind | string;
  fileName?: string;
  fileUrl?: string;
  telegramFileId?: string;
  telegramMessageId?: string;
  telegramChatId?: string;
  telegramChatTitle?: string;
  telegramTopicId?: string;
  telegramTopicName?: string;
  recipientUserId?: string;
  recipientUsername?: string;
  recipientName?: string;
  deliverySource?: string;
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export const telegramFileDeliveryStore = {
  async createDelivery(input: TelegramFileDeliveryInput): Promise<void> {
    await query(
      `
        INSERT INTO telegram_file_deliveries (
          id,
          project_id,
          project_name,
          task_id,
          reference_library_item_id,
          file_kind,
          file_name,
          file_url,
          telegram_file_id,
          telegram_message_id,
          telegram_chat_id,
          telegram_chat_title,
          telegram_topic_id,
          telegram_topic_name,
          recipient_user_id,
          recipient_username,
          recipient_name,
          delivery_source
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18
        )
      `,
      [
        randomUUID(),
        normalizeString(input.projectId),
        normalizeString(input.projectName),
        normalizeString(input.taskId),
        normalizeString(input.referenceLibraryItemId),
        normalizeString(input.fileKind),
        normalizeString(input.fileName),
        normalizeString(input.fileUrl),
        normalizeString(input.telegramFileId),
        normalizeString(input.telegramMessageId),
        normalizeString(input.telegramChatId),
        normalizeString(input.telegramChatTitle),
        normalizeString(input.telegramTopicId),
        normalizeString(input.telegramTopicName),
        normalizeString(input.recipientUserId),
        normalizeString(input.recipientUsername),
        normalizeString(input.recipientName),
        normalizeString(input.deliverySource),
      ]
    );
  },
};
