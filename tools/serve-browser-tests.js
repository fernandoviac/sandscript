/**
 * Static file server for the browser test pages under tests/browser/.
 *
 * Serves the repository root with the COOP/COEP headers that
 * SharedArrayBuffer (session memory, membrane buffers) requires in
 * browsers. Usage:
 *
 *   deno run --allow-net --allow-read tools/serve-browser-tests.js [port]
 *
 * Then open e.g. http://localhost:9377/tests/browser/regexp-smoke.html
 */
const port = Number(Deno.args[0] ?? 9377);
const root = new URL('..', import.meta.url);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

Deno.serve({ port }, async (request) => {
  const path = decodeURIComponent(new URL(request.url).pathname);
  const file = new URL(`.${path}`, root);
  let body;
  try {
    body = await Deno.readFile(file);
  } catch {
    return new Response(`not found: ${path}`, { status: 404 });
  }
  const dot = path.lastIndexOf('.');
  const type = MIME[path.slice(dot)] ?? 'application/octet-stream';
  return new Response(body, {
    headers: {
      'content-type': type,
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
      'cache-control': 'no-store',
    },
  });
});
