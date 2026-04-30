import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'fs-extra';
import axios from 'axios';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cacheRootDir = path.resolve(__dirname, '../../data/google-fonts-cache');
const catalogCachePath = path.join(cacheRootDir, 'cyrillic-catalog.json');
const fontFilesDir = path.join(cacheRootDir, 'files');
const catalogTtlMs = 24 * 60 * 60 * 1000;
const httpTimeoutMs = 20000;

export interface GoogleCyrillicFontOption {
  family: string;
  category: string;
  subsets: string[];
  popularity: number;
}

interface CatalogCachePayload {
  updatedAt: string;
  fonts: GoogleCyrillicFontOption[];
}

interface CssFontSource {
  comment: string;
  weight: number;
  url: string;
  format: string;
}

function normalizeFamilyName(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function toFamilyQueryValue(family: string): string {
  return encodeURIComponent(normalizeFamilyName(family)).replace(/%20/g, '+');
}

function normalizeFontWeight(value: string | number | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(100, Math.min(900, Math.round(value / 100) * 100));
  }

  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'normal') return 400;
  if (raw === 'bold') return 700;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 700;
  return Math.max(100, Math.min(900, Math.round(parsed / 100) * 100));
}

function parseMetadataPayload(raw: string): any {
  const trimmed = raw.trim();
  const jsonStart = trimmed.indexOf('{');
  if (jsonStart === -1) {
    throw new Error('Google Fonts metadata payload has no JSON object');
  }

  return JSON.parse(trimmed.slice(jsonStart));
}

function normalizeCategory(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    return 'sans-serif';
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'sans_serif') return 'sans-serif';
  return normalized.replace(/_/g, '-');
}

function isCyrillicSubset(subset: string): boolean {
  const normalized = subset.trim().toLowerCase();
  return normalized === 'cyrillic' || normalized === 'cyrillic-ext';
}

function buildFallbackCatalog(): GoogleCyrillicFontOption[] {
  return [
    'Roboto',
    'Open Sans',
    'Montserrat',
    'Inter',
    'Rubik',
    'PT Sans',
    'Noto Sans',
    'Nunito',
    'Manrope',
    'Fira Sans',
  ].map((family, index) => ({
    family,
    category: 'sans-serif',
    subsets: ['cyrillic', 'latin'],
    popularity: index + 1,
  }));
}

async function readCachedCatalog(): Promise<CatalogCachePayload | null> {
  if (!(await fs.pathExists(catalogCachePath))) {
    return null;
  }

  try {
    const payload = await fs.readJson(catalogCachePath);
    if (!payload || !Array.isArray(payload.fonts)) {
      return null;
    }
    return payload as CatalogCachePayload;
  } catch {
    return null;
  }
}

async function writeCachedCatalog(fonts: GoogleCyrillicFontOption[]): Promise<void> {
  await fs.ensureDir(cacheRootDir);
  const payload: CatalogCachePayload = {
    updatedAt: new Date().toISOString(),
    fonts,
  };
  await fs.writeJson(catalogCachePath, payload, { spaces: 2 });
}

async function fetchCyrillicCatalogFromGoogle(): Promise<GoogleCyrillicFontOption[]> {
  const response = await axios.get('https://fonts.google.com/metadata/fonts', {
    timeout: httpTimeoutMs,
    responseType: 'text',
    headers: {
      Accept: 'application/json, text/plain, */*',
      'User-Agent': 'SOra2/1.0 (+google-fonts-cyrillic-catalog)',
    },
  });

  const payload = parseMetadataPayload(String(response.data || ''));
  const families = Array.isArray(payload?.familyMetadataList) ? payload.familyMetadataList : [];
  const fonts: GoogleCyrillicFontOption[] = [];

  for (const family of families) {
    const familyName = typeof family?.family === 'string' ? normalizeFamilyName(family.family) : '';
    if (!familyName) {
      continue;
    }

    const subsets = Array.isArray(family?.subsets)
      ? family.subsets.filter((subset: unknown): subset is string => typeof subset === 'string')
      : [];
    if (!subsets.some(isCyrillicSubset)) {
      continue;
    }

    const popularityRaw = Number(family?.popularity);
    const popularity = Number.isFinite(popularityRaw) ? popularityRaw : Number.MAX_SAFE_INTEGER;
    fonts.push({
      family: familyName,
      category: normalizeCategory(family?.category),
      subsets,
      popularity,
    });
  }

  fonts.sort((a, b) => {
    if (a.popularity !== b.popularity) {
      return a.popularity - b.popularity;
    }
    return a.family.localeCompare(b.family);
  });

  return fonts;
}

function slugifyFamily(value: string): string {
  const base = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return base || 'font';
}

function familyHash(value: string): string {
  let hash = 2166136261;
  for (const ch of value) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function extractFontSources(css: string): CssFontSource[] {
  const sources: CssFontSource[] = [];
  const blockPattern = /(?:\/\*\s*([^*]+?)\s*\*\/\s*)?@font-face\s*{([\s\S]*?)}/gi;

  let match: RegExpExecArray | null = blockPattern.exec(css);
  while (match) {
    const comment = (match[1] || '').trim().toLowerCase();
    const body = match[2] || '';
    const weightMatch = body.match(/font-weight:\s*([0-9]+)/i);
    const weight = normalizeFontWeight(weightMatch?.[1] || '400');
    const urlMatch =
      body.match(/url\((['"]?)(https:[^)'" ]+)\1\)\s*format\((['"]?)([^'")]+)\3\)/i) ||
      body.match(/url\((['"]?)(https:[^)'" ]+)\1\)/i);

    const sourceUrl = urlMatch?.[2];
    if (typeof sourceUrl === 'string' && sourceUrl) {
      sources.push({
        comment,
        weight,
        url: sourceUrl,
        format: (urlMatch[4] || '').toLowerCase(),
      });
    }

    match = blockPattern.exec(css);
  }

  return sources;
}

function guessExtension(url: string, format: string): string {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname).replace('.', '').toLowerCase();
    if (ext) {
      return ext;
    }
  } catch {
    // ignore URL parsing and fallback to format map
  }

  if (format.includes('truetype')) return 'ttf';
  if (format.includes('opentype')) return 'otf';
  if (format.includes('woff2')) return 'woff2';
  if (format.includes('woff')) return 'woff';
  return 'font';
}

function scoreFontSource(source: CssFontSource, targetWeight: number): number {
  let score = 0;
  if (source.comment.includes('cyrillic-ext')) score += 300;
  else if (source.comment.includes('cyrillic')) score += 200;
  else if (!source.comment) score += 120;

  const weightDistance = Math.abs(source.weight - targetWeight);
  score -= Math.floor(weightDistance / 10);

  if (source.format.includes('truetype')) score += 80;
  else if (source.format.includes('opentype')) score += 70;
  else if (source.format.includes('woff2')) score += 50;
  else if (source.format.includes('woff')) score += 40;

  return score;
}

async function fetchCssForFamily(family: string, weight: number): Promise<string> {
  const familyParam = toFamilyQueryValue(family);
  const requestUrls = [
    `https://fonts.googleapis.com/css2?family=${familyParam}:wght@${weight}&display=swap`,
    `https://fonts.googleapis.com/css?family=${familyParam}:${weight}&display=swap`,
    `https://fonts.googleapis.com/css2?family=${familyParam}&display=swap`,
  ];

  let lastError: unknown = null;
  for (const requestUrl of requestUrls) {
    try {
      const response = await axios.get(requestUrl, {
        timeout: httpTimeoutMs,
        responseType: 'text',
        headers: {
          Accept: 'text/css,*/*;q=0.1',
          'User-Agent': 'SOra2/1.0 (+google-fonts-cyrillic-download)',
        },
      });
      const css = String(response.data || '').trim();
      if (css) {
        return css;
      }
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`Failed to fetch Google Fonts CSS for "${family}" (${weight}): ${String((lastError as any)?.message || lastError)}`);
}

export class GoogleFontsService {
  public static async listCyrillicFonts(): Promise<GoogleCyrillicFontOption[]> {
    const cached = await readCachedCatalog();
    const cachedTs = cached ? Date.parse(cached.updatedAt || '') : 0;
    const isFresh = Number.isFinite(cachedTs) && Date.now() - cachedTs < catalogTtlMs;
    if (cached?.fonts?.length && isFresh) {
      return cached.fonts;
    }

    try {
      const fonts = await fetchCyrillicCatalogFromGoogle();
      if (fonts.length) {
        await writeCachedCatalog(fonts);
        return fonts;
      }
    } catch (error: any) {
      console.warn('[GoogleFontsService] Failed to refresh Cyrillic catalog:', error?.message || error);
    }

    if (cached?.fonts?.length) {
      return cached.fonts;
    }

    const fallback = buildFallbackCatalog();
    await writeCachedCatalog(fallback);
    return fallback;
  }

  public static async ensureCyrillicFontFile(family: string, weight?: string | number): Promise<string | null> {
    const normalizedFamily = normalizeFamilyName(family);
    if (!normalizedFamily) {
      return null;
    }

    const fonts = await this.listCyrillicFonts();
    const isKnownCyrillic = fonts.some((item) => item.family.toLowerCase() === normalizedFamily.toLowerCase());
    if (!isKnownCyrillic) {
      return null;
    }

    const normalizedWeight = normalizeFontWeight(weight);
    const fileBase = `${slugifyFamily(normalizedFamily)}-${familyHash(normalizedFamily)}-${normalizedWeight}`;
    await fs.ensureDir(fontFilesDir);

    const existing = (await fs.readdir(fontFilesDir))
      .find((entry) => entry.startsWith(`${fileBase}.`));
    if (existing) {
      const filePath = path.join(fontFilesDir, existing);
      const stat = await fs.stat(filePath).catch(() => null);
      if (stat && stat.size > 0) {
        return filePath;
      }
    }

    const css = await fetchCssForFamily(normalizedFamily, normalizedWeight);
    const candidates = extractFontSources(css);
    if (!candidates.length) {
      throw new Error(`No downloadable font sources found in CSS for "${normalizedFamily}"`);
    }

    const selected = [...candidates]
      .sort((a, b) => scoreFontSource(b, normalizedWeight) - scoreFontSource(a, normalizedWeight))[0];
    if (!selected?.url) {
      throw new Error(`Unable to select font source for "${normalizedFamily}"`);
    }

    const extension = guessExtension(selected.url, selected.format);
    const filePath = path.join(fontFilesDir, `${fileBase}.${extension}`);
    const response = await axios.get(selected.url, {
      timeout: httpTimeoutMs,
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'SOra2/1.0 (+google-fonts-cyrillic-download)',
      },
    });
    await fs.writeFile(filePath, Buffer.from(response.data));
    return filePath;
  }
}
