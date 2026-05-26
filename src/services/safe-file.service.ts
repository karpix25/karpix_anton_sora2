import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'fs-extra';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appRootDir = path.resolve(__dirname, '../..');
const dataDir = path.join(appRootDir, 'data');
const trashDir = path.join(dataDir, '.trash');

function normalizeForCompare(filePath: string): string {
  return path.resolve(filePath);
}

function isInsideDirectory(baseDir: string, targetPath: string): boolean {
  const normalizedBase = normalizeForCompare(baseDir);
  const normalizedTarget = normalizeForCompare(targetPath);
  return normalizedTarget.startsWith(`${normalizedBase}${path.sep}`);
}

function buildTrashPath(targetPath: string): string {
  const relativePath = path.relative(appRootDir, normalizeForCompare(targetPath));
  const safeRelativePath = relativePath
    .split(path.sep)
    .filter((part) => part && part !== '.' && part !== '..')
    .join(path.sep);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(trashDir, timestamp, safeRelativePath || path.basename(targetPath));
}

async function getAvailableTrashPath(targetPath: string): Promise<string> {
  const parsed = path.parse(targetPath);
  let candidate = targetPath;
  let suffix = 1;

  while (await fs.pathExists(candidate)) {
    candidate = path.join(parsed.dir, `${parsed.name}-${suffix}${parsed.ext}`);
    suffix += 1;
  }

  return candidate;
}

export class SafeFileService {
  public static getDataDir(): string {
    return dataDir;
  }

  public static getTrashDir(): string {
    return trashDir;
  }

  public static assertUserFilePath(targetPath: string, allowedRoot: string): string {
    const normalizedTarget = normalizeForCompare(targetPath);
    const normalizedAllowedRoot = normalizeForCompare(allowedRoot);

    if (!isInsideDirectory(normalizedAllowedRoot, normalizedTarget)) {
      throw new Error(`Refusing to delete path outside allowed root: ${normalizedTarget}`);
    }

    if (normalizedTarget === normalizedAllowedRoot || normalizedTarget === appRootDir || normalizedTarget === dataDir) {
      throw new Error(`Refusing to delete protected path: ${normalizedTarget}`);
    }

    return normalizedTarget;
  }

  public static async moveUserFileToTrash(targetPath: string, allowedRoot: string): Promise<string | null> {
    const safeTargetPath = this.assertUserFilePath(targetPath, allowedRoot);
    if (!(await fs.pathExists(safeTargetPath))) {
      return null;
    }

    const trashPath = await getAvailableTrashPath(buildTrashPath(safeTargetPath));
    await fs.ensureDir(path.dirname(trashPath));
    await fs.move(safeTargetPath, trashPath, { overwrite: false });
    console.log(`[SafeFileService] Moved to trash: ${safeTargetPath} -> ${trashPath}`);
    return trashPath;
  }
}
