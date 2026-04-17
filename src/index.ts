import './init-errors.js';
import { bot } from './bot/bot.js';
import path from 'node:path';
import dns from 'node:dns';

// Ensure common binary paths are in PATH (needed for ffmpeg/ffprobe on some systems)
const extraPaths = ['/usr/local/bin', '/opt/homebrew/bin'];
const currentPath = process.env.PATH || '';
process.env.PATH = [...extraPaths, ...currentPath.split(path.delimiter)].join(path.delimiter);

dns.setDefaultResultOrder('ipv4first');

import { config } from './config.js';
import { startWebServer } from './web/server.js';
import { closeDatabase, initDatabase } from './storage/db.js';
import { GenerationRecoveryService } from './services/generation-recovery.service.js';

console.log('🚀 Starting Sora 2 & Veo 3.1 Video Automation Tool...');

let isShuttingDown = false;

const startBot = async (attempt = 1): Promise<void> => {
  const maxAttempts = 5;
  const delay = Math.min(attempt * 2000, 10000);

  try {
    console.log(`🤖 Starting Telegram bot polling (attempt ${attempt}/${maxAttempts})...`);
    await bot.telegram.deleteWebhook({ drop_pending_updates: false });
    await bot.launch();
    console.log('✅ Bot is running! Press Ctrl+C to stop.');
  } catch (error: any) {
    console.error(`❌ Bot failed to start (attempt ${attempt}):`, error.message);
    if (attempt < maxAttempts) {
      console.log(`📡 Retrying in ${delay / 1000}s...`);
      setTimeout(() => {
        startBot(attempt + 1).catch(console.error);
      }, delay);
    } else {
      console.error('🛑 Max bot startup attempts reached.');
      console.error('Full connection error:', error);
    }
  }
};

async function startBotWebhook(): Promise<void> {
  const webhookUrl = config.telegram.webhook.url.trim();
  if (!webhookUrl) {
    throw new Error('TELEGRAM_WEBHOOK_URL is required when TELEGRAM_USE_WEBHOOK=true');
  }

  const secretToken = config.telegram.webhook.secretToken.trim();
  await bot.telegram.setWebhook(webhookUrl, {
    drop_pending_updates: false,
    ...(secretToken ? { secret_token: secretToken } : {}),
  });

  const webhookInfo = await bot.telegram.getWebhookInfo();
  console.log(`🪝 Telegram webhook configured: ${webhookInfo.url || webhookUrl}`);
}

async function bootstrap(): Promise<void> {
  await initDatabase();
  console.log('🗄️ PostgreSQL connected and schema is ready.');

  await startWebServer();
  GenerationRecoveryService.start();

  if (config.telegram.isConfigured) {
    if (config.telegram.webhook.enabled) {
      await startBotWebhook();
    } else {
      await startBot();
    }
  } else {
    console.log('ℹ️ Telegram bot is disabled because TELEGRAM_BOT_TOKEN is missing or still uses a placeholder value.');
  }
}

async function gracefulShutdown(signal: 'SIGINT' | 'SIGTERM'): Promise<void> {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  try {
    bot.stop(signal);
  } catch {
    // no-op
  }

  try {
    await closeDatabase();
  } catch (error: any) {
    console.error('Failed to close PostgreSQL pool:', error?.message || error);
  }
}

bootstrap().catch((error: Error) => {
  console.error('❌ Application startup failed:', error.message);
  process.exitCode = 1;
});

// Enable graceful stop
process.once('SIGINT', () => {
  gracefulShutdown('SIGINT').catch(console.error);
});
process.once('SIGTERM', () => {
  gracefulShutdown('SIGTERM').catch(console.error);
});
