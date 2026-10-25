import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assertLocalUrl } from "./local-only.mjs";

const url = assertLocalUrl("APP_TEST_URL", process.env.APP_TEST_URL || "http://127.0.0.1:5500");
const root = resolve(fileURLToPath(new URL("../../../app-v3/", import.meta.url)));
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };

createServer(async (request, response) => {
  const pathname = new URL(request.url, url).pathname
    .replace(/^\/app(?:\/|$)/, "")
    .replace(/^\/+/, "") || "index.html";
  const path = resolve(root, pathname);
  if (path !== root && !path.startsWith(`${root}${sep}`)) return response.writeHead(403).end();
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not a file");
    response.writeHead(200, { "content-type": mime[extname(path)] || "application/octet-stream" });
    createReadStream(path).pipe(response);
  } catch {
    response.writeHead(404).end();
  }
}).listen(Number(url.port || 5500), url.hostname);
