/**
 * Astro integration: write /write/manifest.json at build time.
 *
 * The manifest lists every markdown file under src/content with its git blob
 * sha and size, as of this build. In production the writing app lists posts
 * through GitHub's anonymous API (60 requests per hour per IP address, shared
 * by everyone behind the same carrier NAT); when that call is refused and
 * nothing is cached on the device, the app falls back to this file, so it
 * still has a list to show (src/write/data/github-source.ts).
 *
 * Runs in Node during `astro build` only — never in dev (the working tree is
 * read directly there) and never in the worker.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTENT_ROOT = 'src/content';

/** `sha1("blob <bytes>\0" + content)`: the id git and the GitHub API give this content. */
export function gitBlobSha(bytes) {
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

function markdownFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return markdownFiles(path);
    return name.endsWith('.md') ? [path] : [];
  });
}

/** The manifest for the repo at `root`. */
export function buildManifest(root, now = Date.now()) {
  const contentDir = join(root, CONTENT_ROOT);
  const files = existsSync(contentDir)
    ? markdownFiles(contentDir)
        .map((file) => {
          const bytes = readFileSync(file);
          return [relative(root, file).split(sep).join('/'), gitBlobSha(bytes), bytes.byteLength];
        })
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    : [];
  return { v: 1, fetchedAt: now, truncated: false, files };
}

export default function writeManifest() {
  let root = process.cwd();
  return {
    name: 'write-manifest',
    hooks: {
      'astro:config:done': ({ config }) => {
        root = fileURLToPath(config.root);
      },
      'astro:build:done': ({ dir, logger }) => {
        const out = join(fileURLToPath(dir), 'write', 'manifest.json');
        const manifest = buildManifest(root);
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, JSON.stringify(manifest));
        logger.info(`${manifest.files.length} posts listed in ${relative(root, out)}`);
      },
    },
  };
}
