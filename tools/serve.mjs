/**
 * serve.mjs — a minimal static file server for local development.
 *
 *   node tools/serve.mjs [port]
 *
 * The game is plain static files, but ES modules and module workers cannot be
 * loaded from `file://`, so a server is required while developing. GitHub Pages
 * serves the same tree without any build step.
 */

import { createServer } from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

const root = resolve(process.cwd());
const port = Number(process.argv[2] ?? process.env.PORT ?? 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Resolves a request path to a file inside `root`, refusing anything that
 * escapes it.
 * @param {string} url
 * @returns {string|null}
 */
function resolvePath(url) {
  const pathname = decodeURIComponent(new URL(url, 'http://localhost').pathname);
  const candidate = normalize(join(root, pathname));
  if (!candidate.startsWith(root + sep) && candidate !== root) return null;
  return candidate;
}

const server = createServer(async (request, response) => {
  const started = Date.now();
  let target = resolvePath(request.url ?? '/');
  if (target === null) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const stats = await fs.stat(target);
    if (stats.isDirectory()) target = join(target, 'index.html');
    const body = createReadStream(target);
    response.writeHead(200, {
      'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    body.pipe(response);
    body.on('end', () => {
      console.log(`${response.statusCode} ${request.method} ${request.url} ${Date.now() - started}ms`);
    });
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    console.log(`404 ${request.method} ${request.url}`);
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Serving ${root} at http://127.0.0.1:${port}/`);
});
