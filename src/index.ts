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

console.log('🚀 Starting Sora 2 & Veo 3.1 Video Automation Tool...');

startWebServer().catch((error: Error) => {
  console.error('❌ Web admin failed to start:', error.message);
});

if (config.telegram.isConfigured) {
  const startBot = async (attempt = 1): Promise<void> => {
    const maxAttempts = 5;
    const delay = Math.min(attempt * 2000, 10000);

    try {
      console.log(`🤖 Starting Telegram bot polling (attempt ${attempt}/${maxAttempts})...`);
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

  startBot().catch(console.error);
} else {
  console.log('ℹ️ Telegram bot is disabled because TELEGRAM_BOT_TOKEN is missing or still uses a placeholder value.');
}

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
