import { readdir } from 'node:fs/promises';
import path from 'node:path';

const repoRoot = process.cwd();
const sourceRoot = path.join(repoRoot, 'src');
const blockedExtensions = ['.js', '.js.map', '.d.ts', '.d.ts.map'];
const allowedPrefixes = [`${path.join('src', 'web', 'public')}${path.sep}`];

function hasBlockedExtension(filePath) {
  return blockedExtensions.some((extension) => filePath.endsWith(extension));
}

function isAllowedSourceArtifact(relativePath) {
  return allowedPrefixes.some((prefix) => relativePath.startsWith(prefix));
}

async function collectBlockedArtifacts(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const blocked = [];

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.relative(repoRoot, absolutePath);

    if (entry.isDirectory()) {
      blocked.push(...await collectBlockedArtifacts(absolutePath));
      continue;
    }

    if (hasBlockedExtension(relativePath) && !isAllowedSourceArtifact(relativePath)) {
      blocked.push(relativePath);
    }
  }

  return blocked;
}

const blockedArtifacts = await collectBlockedArtifacts(sourceRoot);

if (blockedArtifacts.length) {
  console.error('Blocked compiled artifacts found in src/:');
  for (const artifact of blockedArtifacts) {
    console.error(`- ${artifact}`);
  }
  console.error('\nRemove these files before running or building the service.');
  process.exit(1);
}

console.log('No blocked compiled artifacts found in src/.');
