import dotenv from 'dotenv';
dotenv.config();

function isConfiguredSecret(value: string): boolean {
  const normalized = value.trim();
  return Boolean(normalized) && !normalized.startsWith('your_');
}

function parseProviderOrder(value: string | undefined): string[] {
  const providers = (value || 'google-vertex,google-ai-studio')
    .split(',')
    .map((provider) => provider.trim())
    .filter(Boolean);
  return providers.length > 0 ? providers : ['google-vertex', 'google-ai-studio'];
}

function parsePort(...values: Array<string | undefined>): number {
  for (const value of values) {
    if (!value || value.trim() === '') {
      continue;
    }

    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }

  return 3000;
}

export const config = {
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    isConfigured: isConfiguredSecret(process.env.TELEGRAM_BOT_TOKEN || ''),
  },
  web: {
    host: process.env.WEB_HOST || process.env.HOST || '0.0.0.0',
    port: parsePort(process.env.WEB_PORT, process.env.PORT, '3000'),
  },
  openRouter: {
    apiKey: process.env.OPENROUTER_API_KEY || '',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: {
      flash: process.env.OPENROUTER_MODEL_FLASH || 'google/gemini-2.5-flash',
      flashFallback: process.env.OPENROUTER_MODEL_FLASH_FALLBACK || 'google/gemini-2.5-pro',
      pro: process.env.OPENROUTER_MODEL_PRO || 'google/gemini-2.5-pro',
    },
    providers: {
      order: parseProviderOrder(process.env.OPENROUTER_PROVIDER_ORDER),
      allowFallbacks: (process.env.OPENROUTER_ALLOW_FALLBACKS || 'true').toLowerCase() !== 'false',
    },
  },
  kieAi: {
    apiKey: process.env.KIE_AI_API_KEY || '',
    baseUrl: 'https://api.kie.ai/api/v1',
  },
  waveSpeed: {
    apiKey: process.env.WAVESPEED_API_KEY || '',
    baseUrl: 'https://api.wavespeed.ai/api/v3',
    sora2DurationSeconds: Number(process.env.WAVESPEED_SORA2_DURATION || 4),
    isConfigured: isConfiguredSecret(process.env.WAVESPEED_API_KEY || ''),
  },
  yandexDisk: {
    token: process.env.YANDEX_TOKEN || '',
    isConfigured: isConfiguredSecret(process.env.YANDEX_TOKEN || ''),
  },
  rapidApi: {
    key: process.env.RAPIDAPI_KEY || '',
    host: process.env.RAPIDAPI_HOST || 'instagram-social-api.p.rapidapi.com',
    base: process.env.IG_API_BASE || 'https://instagram-social-api.p.rapidapi.com/v1/info',
  },
};

if (
  !config.telegram.isConfigured ||
  !config.openRouter.apiKey ||
  !config.kieAi.apiKey ||
  !config.rapidApi.key ||
  !config.yandexDisk.isConfigured
) {
  console.warn('Warning: Some API keys are missing in .env file!');
}
