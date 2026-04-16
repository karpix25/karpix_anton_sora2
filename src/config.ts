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

function parseBoolean(value: string | undefined, defaultValue = false): boolean {
  if (!value) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }

  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return defaultValue;
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

function parsePositiveInt(value: string | undefined, defaultValue: number): number {
  if (!value || value.trim() === '') {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }

  return Math.floor(parsed);
}

function normalizePublicUrl(value: string | undefined): string {
  const normalized = (value || '').trim();
  if (!normalized) {
    return '';
  }

  return normalized.replace(/\/+$/, '');
}

function normalizeWebhookPath(value: string | undefined): string {
  const normalized = (value || '').trim();
  if (!normalized) {
    return '/telegram/webhook';
  }

  if (normalized.startsWith('/')) {
    return normalized;
  }

  return `/${normalized}`;
}

function deriveWebhookPathFromUrl(webhookUrl: string): string {
  if (!webhookUrl.trim()) {
    return '/telegram/webhook';
  }

  try {
    const parsed = new URL(webhookUrl);
    return normalizeWebhookPath(parsed.pathname || '/telegram/webhook');
  } catch {
    return '/telegram/webhook';
  }
}

export const config = {
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    isConfigured: isConfiguredSecret(process.env.TELEGRAM_BOT_TOKEN || ''),
    handlerTimeoutMs: parsePositiveInt(process.env.TELEGRAM_HANDLER_TIMEOUT_MS, 20 * 60 * 1000),
    webhook: {
      enabled: parseBoolean(process.env.TELEGRAM_USE_WEBHOOK, false),
      url: process.env.TELEGRAM_WEBHOOK_URL || '',
      secretToken: process.env.TELEGRAM_WEBHOOK_SECRET || '',
      path: normalizeWebhookPath(
        process.env.TELEGRAM_WEBHOOK_PATH ||
          deriveWebhookPathFromUrl(process.env.TELEGRAM_WEBHOOK_URL || '')
      ),
    },
  },
  web: {
    host: process.env.WEB_HOST || process.env.HOST || '0.0.0.0',
    port: parsePort(process.env.WEB_PORT, process.env.PORT, '3000'),
    publicUrl: normalizePublicUrl(process.env.WEB_PUBLIC_URL),
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
