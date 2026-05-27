import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'fs-extra';
import { query } from '../src/storage/db.js';
import { config } from '../src/config.js';
import { S3StorageService } from '../src/services/s3-storage.service.js';
import { VideoPostprocessService } from '../src/services/video-postprocess.service.js';
import { YandexDiskService } from '../src/services/yandex-disk.service.js';
import type { ReferenceTextOverlay } from '../src/domain/reference-library.js';

interface RestoreArgs {
  databaseUrl: string;
  dryRun: boolean;
  onlyNotPublished: boolean;
  withOverlays: boolean;
  limit: number;
  yes: boolean;
}

interface RestoreCandidateRow {
  task_id: string;
  project_id: string;
  project_code: string;
  project_name: string;
  yandex_disk_folder: string;
  text_style: unknown;
  end_frame_text: string;
  end_frame_vertical_margin: number;
  end_frame_width_percent: number;
  end_frame_x_percent: number;
  reference_library_item_id: string;
  video_s3_bucket: string;
  video_s3_object_key: string;
  video_file_name: string;
  audio_s3_bucket: string;
  audio_s3_object_key: string;
  overlay_texts: unknown;
  publication_url: string;
}

interface RestoreSummary {
  candidates: number;
  restored: number;
  failed: number;
  skipped: number;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appRootDir = path.resolve(__dirname, '..');
const restoreWorkDir = path.join(appRootDir, 'data', 'restore-generated-videos');

function readFlagValue(argv: string[], name: string): string {
  const prefix = `${name}=`;
  const inlineValue = argv.find((arg) => arg.startsWith(prefix));
  if (inlineValue) {
    return inlineValue.slice(prefix.length);
  }

  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || '' : '';
}

function parsePositiveInteger(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseArgs(argv: string[]): RestoreArgs {
  const databaseUrl = readFlagValue(argv, '--database-url');
  return {
    databaseUrl,
    dryRun: argv.includes('--dry-run'),
    onlyNotPublished: argv.includes('--only-not-published'),
    withOverlays: argv.includes('--with-overlays'),
    limit: parsePositiveInteger(readFlagValue(argv, '--limit'), 20),
    yes: argv.includes('--yes'),
  };
}

function normalizeOverlays(value: unknown): ReferenceTextOverlay[] {
  if (typeof value === 'string') {
    try {
      return normalizeOverlays(JSON.parse(value));
    } catch {
      return [];
    }
  }

  return Array.isArray(value) ? (value as ReferenceTextOverlay[]) : [];
}

function sqlTextNotEmpty(expression: string): string {
  return `COALESCE(${expression}, '') <> ''`;
}

async function restoreTableExists(): Promise<boolean> {
  const result = await query<{ exists: boolean }>(
    `SELECT to_regclass('public.generation_restore_runs') IS NOT NULL AS exists`
  );
  return Boolean(result.rows[0]?.exists);
}

async function ensureRestoreTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS generation_restore_runs (
      task_id TEXT PRIMARY KEY REFERENCES generation_tasks(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      yandex_disk_path TEXT NOT NULL DEFAULT '',
      yandex_download_url TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '',
      restored_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function markRestoreResult(
  taskId: string,
  input: { status: 'restored' | 'failed'; yandexDiskPath?: string; yandexDownloadUrl?: string; errorMessage?: string }
): Promise<void> {
  await query(
    `
      INSERT INTO generation_restore_runs (
        task_id, status, yandex_disk_path, yandex_download_url, error_message, restored_at, updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5,
        CASE WHEN $2 = 'restored' THEN NOW() ELSE NULL END,
        NOW()
      )
      ON CONFLICT (task_id) DO UPDATE SET
        status = EXCLUDED.status,
        yandex_disk_path = EXCLUDED.yandex_disk_path,
        yandex_download_url = EXCLUDED.yandex_download_url,
        error_message = EXCLUDED.error_message,
        restored_at = EXCLUDED.restored_at,
        updated_at = NOW()
    `,
    [
      taskId,
      input.status,
      input.yandexDiskPath || '',
      input.yandexDownloadUrl || '',
      input.errorMessage || '',
    ]
  );
}

async function fetchCandidates(args: RestoreArgs): Promise<RestoreCandidateRow[]> {
  const where: string[] = [
    `t.status = 'completed'`,
    sqlTextNotEmpty('t.s3_object_key'),
    sqlTextNotEmpty('r.audio_s3_object_key'),
  ];

  if (args.onlyNotPublished) {
    where.push(`COALESCE(t.publication_url, '') = ''`);
  }

  if (args.withOverlays) {
    where.push(`t.overlay_texts IS NOT NULL`);
    where.push(`t.overlay_texts::text <> '[]'`);
    where.push(`t.overlay_texts::text <> ''`);
  }

  if (!args.dryRun && await restoreTableExists()) {
    where.push(`
      NOT EXISTS (
        SELECT 1
        FROM generation_restore_runs gr
        WHERE gr.task_id = t.id AND gr.status = 'restored'
      )
    `);
  }

  const result = await query<RestoreCandidateRow>(
    `
      SELECT
        t.id AS task_id,
        p.id AS project_id,
        p.project_code,
        p.name AS project_name,
        p.yandex_disk_folder,
        p.text_style,
        p.end_frame_text,
        p.end_frame_vertical_margin,
        p.end_frame_width_percent,
        p.end_frame_x_percent,
        t.reference_library_item_id,
        t.s3_bucket AS video_s3_bucket,
        t.s3_object_key AS video_s3_object_key,
        t.video_file_name,
        r.audio_s3_bucket,
        r.audio_s3_object_key,
        t.overlay_texts,
        t.publication_url
      FROM generation_tasks t
      JOIN projects p ON p.id = t.project_id
      JOIN reference_library r ON r.id = t.reference_library_item_id
      WHERE ${where.join('\n        AND ')}
      ORDER BY t.created_at ASC, t.id ASC
      LIMIT $1
    `,
    [args.limit]
  );

  return result.rows;
}

async function restoreCandidate(candidate: RestoreCandidateRow): Promise<void> {
  const taskWorkDir = path.join(restoreWorkDir, candidate.task_id);
  const sourceVideoPath = path.join(taskWorkDir, 'source.mp4');
  const audioPath = path.join(taskWorkDir, 'audio.m4a');
  let outputPath = '';

  try {
    await fs.ensureDir(taskWorkDir);
    await S3StorageService.downloadObjectToFile({
      bucket: candidate.video_s3_bucket || config.s3.bucket,
      objectKey: candidate.video_s3_object_key,
      filePath: sourceVideoPath,
    });
    await S3StorageService.downloadObjectToFile({
      bucket: candidate.audio_s3_bucket || config.s3.bucket,
      objectKey: candidate.audio_s3_object_key,
      filePath: audioPath,
    });

    outputPath = await VideoPostprocessService.applyAudioTrack({
      taskId: `restore-${candidate.task_id}`,
      generatedVideoUrl: sourceVideoPath,
      audioFilePath: audioPath,
      textOverlays: normalizeOverlays(candidate.overlay_texts),
      textStyle: candidate.text_style,
      endFrameText: candidate.end_frame_text || '',
      endFrameVerticalMargin: candidate.end_frame_vertical_margin,
      endFrameWidthPercent: candidate.end_frame_width_percent,
      endFrameXPercent: candidate.end_frame_x_percent,
    });

    const uploadInput: Parameters<typeof YandexDiskService.uploadGeneratedVideoFile>[0] = {
      projectName: candidate.project_name,
      projectCode: candidate.project_code,
      projectFolder: candidate.yandex_disk_folder,
      taskId: candidate.task_id,
      filePath: outputPath,
    };
    if (candidate.video_file_name) {
      uploadInput.fileName = candidate.video_file_name;
    }

    const upload = await YandexDiskService.uploadGeneratedVideoFile(uploadInput);

    await query(
      `
        UPDATE generation_tasks
        SET
          yandex_disk_path = $2,
          yandex_download_url = $3,
          stored_at = $4,
          video_file_name = COALESCE(NULLIF(video_file_name, ''), $5),
          updated_at = NOW()
        WHERE id = $1
      `,
      [
        candidate.task_id,
        upload.diskPath,
        upload.downloadUrl,
        upload.syncedAt,
        candidate.video_file_name || path.basename(upload.diskPath),
      ]
    );

    await markRestoreResult(candidate.task_id, {
      status: 'restored',
      yandexDiskPath: upload.diskPath,
      yandexDownloadUrl: upload.downloadUrl,
    });
    console.log(`[restore] restored task=${candidate.task_id} project="${candidate.project_name}" yandex="${upload.diskPath}"`);
  } catch (error: any) {
    const message = error?.message || String(error);
    await markRestoreResult(candidate.task_id, {
      status: 'failed',
      errorMessage: message.slice(0, 1000),
    });
    console.error(`[restore] failed task=${candidate.task_id}: ${message}`);
    throw error;
  } finally {
    if (outputPath && await fs.pathExists(outputPath)) {
      await fs.remove(outputPath);
    }
    await fs.remove(taskWorkDir);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.databaseUrl) {
    process.env.DATABASE_URL = args.databaseUrl;
  }

  if (!args.dryRun && !args.yes) {
    throw new Error('Refusing to restore without --yes. Use --dry-run first, then add --yes for real restore.');
  }

  if (!S3StorageService.isConfigured()) {
    throw new Error('S3 is not configured. Run this inside the app environment with S3 env vars.');
  }

  if (!YandexDiskService.isConfigured()) {
    throw new Error('Yandex Disk is not configured. Run this inside the app environment with YANDEX_TOKEN.');
  }

  if (!args.dryRun) {
    await ensureRestoreTable();
  }

  const candidates = await fetchCandidates(args);
  const summary: RestoreSummary = {
    candidates: candidates.length,
    restored: 0,
    failed: 0,
    skipped: 0,
  };

  console.log(
    `[restore] mode=${args.dryRun ? 'dry-run' : 'restore'} limit=${args.limit} onlyNotPublished=${args.onlyNotPublished} withOverlays=${args.withOverlays} candidates=${candidates.length}`
  );

  if (args.dryRun) {
    for (const candidate of candidates) {
      console.log(
        `[restore:dry-run] task=${candidate.task_id} project="${candidate.project_name}" video=${candidate.video_s3_object_key} audio=${candidate.audio_s3_object_key} overlays=${normalizeOverlays(candidate.overlay_texts).length} published=${Boolean(candidate.publication_url)}`
      );
    }
    return;
  }

  for (const candidate of candidates) {
    try {
      await restoreCandidate(candidate);
      summary.restored += 1;
    } catch {
      summary.failed += 1;
    }
  }

  console.log(
    `[restore] done candidates=${summary.candidates} restored=${summary.restored} failed=${summary.failed} skipped=${summary.skipped}`
  );
}

main().catch((error: any) => {
  console.error(`[restore] fatal: ${error?.message || error}`);
  process.exitCode = 1;
});
