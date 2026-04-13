import fs from 'fs-extra';
import axios from 'axios';
import FormData from 'form-data';
import { config } from '../config.js';

function getTelegramApiBaseUrl(): string {
  return `https://api.telegram.org/bot${config.telegram.token}`;
}

function getTelegramFileBaseUrl(): string {
  return `https://api.telegram.org/file/bot${config.telegram.token}`;
}

export interface TelegramUploadResult {
  fileId: string;
  messageId: string;
  fileUrl: string;
  syncedAt: string;
}

export class TelegramMediaService {
  public static isConfigured(): boolean {
    return config.telegram.isConfigured;
  }

  public static async uploadReferenceImageToTopic(input: {
    chatId: string;
    topicId: string;
    filePath: string;
    fileName: string;
    caption?: string;
  }): Promise<TelegramUploadResult> {
    if (!this.isConfigured()) {
      throw new Error('Telegram bot token is not configured');
    }

    if (!(await fs.pathExists(input.filePath))) {
      throw new Error(`Reference image file does not exist: ${input.filePath}`);
    }

    const form = new FormData();
    form.append('chat_id', input.chatId);
    form.append('message_thread_id', input.topicId);
    form.append('caption', input.caption ?? 'SOra2 project reference image');
    form.append('document', fs.createReadStream(input.filePath), {
      filename: input.fileName,
      contentType: 'application/octet-stream',
    });

    const response = await axios.post(`${getTelegramApiBaseUrl()}/sendDocument`, form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
    });

    const result = response.data?.result;
    const fileId = result?.document?.file_id;
    const messageId = result?.message_id;
    if (!fileId || !messageId) {
      throw new Error('Telegram sendDocument did not return file_id');
    }

    const fileUrl = await this.getFileDownloadUrl(fileId);

    return {
      fileId,
      messageId: String(messageId),
      fileUrl,
      syncedAt: new Date().toISOString(),
    };
  }

  public static async getFileDownloadUrl(fileId: string): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error('Telegram bot token is not configured');
    }

    const response = await axios.get(`${getTelegramApiBaseUrl()}/getFile`, {
      params: { file_id: fileId },
    });

    const filePath = response.data?.result?.file_path;
    if (!filePath) {
      throw new Error('Telegram getFile did not return file_path');
    }

    return `${getTelegramFileBaseUrl()}/${filePath}`;
  }
}
