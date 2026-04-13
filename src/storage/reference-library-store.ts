import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'fs-extra';
import type {
  ReferenceLibraryInput,
  ReferenceLibraryItem,
  ReferenceLibraryStatus,
  ReferenceTextOverlay,
  ReferenceLibraryUpdate,
} from '../domain/reference-library.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.resolve(__dirname, '../../data');
const referencesFilePath = path.join(dataDir, 'reference-library.json');

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeSourceUrlKey(value: unknown): string {
  const source = normalizeString(value);
  if (!source) {
    return '';
  }

  const reelMatch = source.match(/instagram\.com\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)/i);
  if (reelMatch?.[1]) {
    return `instagram:${reelMatch[1].toLowerCase()}`;
  }

  return source
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function normalizeDurationSeconds(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function normalizeStatus(value: unknown): ReferenceLibraryStatus {
  return value === 'parsing' ||
    value === 'analyzing' ||
    value === 'analyzed' ||
    value === 'failed'
    ? value
    : 'received';
}

function clampPercent(value: unknown, fallback = 0): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.max(0, Math.min(1, numeric));
}

function normalizeTextOverlays(value: unknown): ReferenceTextOverlay[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item, index) => {
      if (!item || typeof item !== 'object') {
        return null;
      }

      const overlay = item as Partial<ReferenceTextOverlay>;
      const text = normalizeString(overlay.text);
      if (!text) {
        return null;
      }

      const anchor = overlay.anchor || 'top-center';
      const validAnchor = anchor === 'top-left' ||
        anchor === 'top-center' ||
        anchor === 'top-right' ||
        anchor === 'center-left' ||
        anchor === 'center' ||
        anchor === 'center-right' ||
        anchor === 'bottom-left' ||
        anchor === 'bottom-center' ||
        anchor === 'bottom-right'
        ? anchor
        : 'top-center';

      const startSeconds = normalizeDurationSeconds(overlay.startSeconds);
      const endSeconds = normalizeDurationSeconds(overlay.endSeconds);
      if (endSeconds <= startSeconds) {
        return null;
      }

      return {
        id: normalizeString(overlay.id) || `overlay-${index + 1}`,
        text,
        startSeconds,
        endSeconds,
        anchor: validAnchor,
        xPercent: clampPercent(overlay.xPercent, 0.5),
        yPercent: clampPercent(overlay.yPercent, 0.12),
        fontSizePercent: clampPercent(overlay.fontSizePercent, 0.04),
        textColor: normalizeString(overlay.textColor) || '#FFFFFF',
        box: Boolean(overlay.box),
        boxColor: normalizeString(overlay.boxColor) || '#000000',
        boxOpacity: Math.max(0, Math.min(1, typeof overlay.boxOpacity === 'number' ? overlay.boxOpacity : Number(overlay.boxOpacity) || 0)),
      } satisfies ReferenceTextOverlay;
    })
    .filter((item): item is ReferenceTextOverlay => Boolean(item));
}

function sanitizeItem(input: ReferenceLibraryInput, existing?: ReferenceLibraryItem): ReferenceLibraryItem {
  const timestamp = nowIso();

  return {
    id: existing?.id ?? randomUUID(),
    projectId: normalizeString(input.projectId ?? existing?.projectId),
    sourceUrl: normalizeString(input.sourceUrl ?? existing?.sourceUrl),
    directVideoUrl: normalizeString(input.directVideoUrl ?? existing?.directVideoUrl),
    thumbnailUrl: normalizeString(input.thumbnailUrl ?? existing?.thumbnailUrl),
    audioFilePath: normalizeString(input.audioFilePath ?? existing?.audioFilePath),
    audioStoredAt: normalizeString(input.audioStoredAt ?? existing?.audioStoredAt),
    durationSeconds: normalizeDurationSeconds(input.durationSeconds ?? existing?.durationSeconds),
    textOverlays: normalizeTextOverlays(input.textOverlays ?? existing?.textOverlays),
    status: normalizeStatus(input.status ?? existing?.status),
    analysis: normalizeString(input.analysis ?? existing?.analysis),
    errorMessage: normalizeString(input.errorMessage ?? existing?.errorMessage),
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
}

async function ensureStorage(): Promise<void> {
  await fs.ensureDir(dataDir);

  if (!(await fs.pathExists(referencesFilePath))) {
    await fs.writeJson(referencesFilePath, { items: [] }, { spaces: 2 });
  }
}

async function loadItems(): Promise<ReferenceLibraryItem[]> {
  await ensureStorage();
  const data = (await fs.readJson(referencesFilePath)) as { items?: ReferenceLibraryInput[] };
  const items = Array.isArray(data.items) ? data.items : [];
  return items
    .map((item) => sanitizeItem(item, item as ReferenceLibraryItem))
    .filter((item) => item.projectId && item.sourceUrl);
}

async function saveItems(items: ReferenceLibraryItem[]): Promise<void> {
  await ensureStorage();
  await fs.writeJson(referencesFilePath, { items }, { spaces: 2 });
}

export const referenceLibraryStore = {
  async getItem(itemId: string): Promise<ReferenceLibraryItem | null> {
    const items = await loadItems();
    return items.find((item) => item.id === itemId) ?? null;
  },

  async listProjectItems(projectId: string): Promise<ReferenceLibraryItem[]> {
    const items = await loadItems();
    return items
      .filter((item) => item.projectId === normalizeString(projectId))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  },

  async createItem(input: ReferenceLibraryInput): Promise<ReferenceLibraryItem> {
    const items = await loadItems();
    const item = sanitizeItem(input);
    items.unshift(item);
    await saveItems(items);
    return item;
  },

  async deleteItem(itemId: string): Promise<ReferenceLibraryItem | null> {
    const items = await loadItems();
    const index = items.findIndex((item) => item.id === normalizeString(itemId));
    if (index === -1) {
      return null;
    }

    const [deletedItem] = items.splice(index, 1);
    await saveItems(items);
    return deletedItem ?? null;
  },

  async deleteProjectItems(projectId: string): Promise<void> {
    const items = await loadItems();
    const filteredItems = items.filter((item) => item.projectId !== normalizeString(projectId));
    await saveItems(filteredItems);
  },

  async findProjectItemBySourceUrl(projectId: string, sourceUrl: string): Promise<ReferenceLibraryItem | null> {
    const normalizedProjectId = normalizeString(projectId);
    const normalizedSourceKey = normalizeSourceUrlKey(sourceUrl);
    if (!normalizedProjectId || !normalizedSourceKey) {
      return null;
    }

    const items = await loadItems();
    return (
      items.find(
        (item) =>
          item.projectId === normalizedProjectId &&
          normalizeSourceUrlKey(item.sourceUrl) === normalizedSourceKey
      ) ?? null
    );
  },

  async updateItem(itemId: string, update: ReferenceLibraryUpdate): Promise<ReferenceLibraryItem | null> {
    const items = await loadItems();
    const index = items.findIndex((item) => item.id === itemId);
    if (index === -1) {
      return null;
    }

    const existing = items[index];
    if (!existing) {
      return null;
    }
    const nextItem = sanitizeItem(
      {
        projectId: existing.projectId,
        sourceUrl: existing.sourceUrl,
        directVideoUrl: update.directVideoUrl ?? existing.directVideoUrl,
        thumbnailUrl: update.thumbnailUrl ?? existing.thumbnailUrl,
        audioFilePath: update.audioFilePath ?? existing.audioFilePath,
        audioStoredAt: update.audioStoredAt ?? existing.audioStoredAt,
        durationSeconds: update.durationSeconds ?? existing.durationSeconds,
        textOverlays: update.textOverlays ?? existing.textOverlays,
        status: update.status ?? existing.status,
        analysis: update.analysis ?? existing.analysis,
        errorMessage: update.errorMessage ?? existing.errorMessage,
      },
      existing
    );
    items[index] = nextItem;
    await saveItems(items);
    return nextItem;
  },
};
