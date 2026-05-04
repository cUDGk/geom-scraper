import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { scrape, type ScrapeOptions } from "./extract.js";
import type { Preset } from "./infer.js";

const PORT = Number(process.env.PORT ?? 8765);
const HOST = process.env.HOST ?? "127.0.0.1";

interface ScrapeRequest {
  url?: string;
  preset?: Preset;
  group_index?: number;
  all_groups?: boolean;
  wait_ms?: number;
  no_stealth?: boolean;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function toOptions(p: ScrapeRequest): ScrapeOptions {
  return {
    preset: p.preset,
    groupIndex: p.group_index,
    allGroups: p.all_groups,
    waitMs: p.wait_ms,
    stealth: p.no_stealth ? false : undefined,
  };
}

async function handleScrape(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let payload: ScrapeRequest = {};
  if (req.method === "POST") {
    const body = await readBody(req);
    if (body) {
      try {
        payload = JSON.parse(body) as ScrapeRequest;
      } catch {
        return send(res, 400, { error: "invalid JSON body" });
      }
    }
  } else {
    const u = new URL(req.url ?? "/", `http://${req.headers.host}`);
    payload = {
      url: u.searchParams.get("url") ?? undefined,
      preset: (u.searchParams.get("preset") as Preset) ?? undefined,
      group_index: u.searchParams.get("group_index")
        ? Number(u.searchParams.get("group_index"))
        : undefined,
      all_groups: u.searchParams.get("all_groups") === "true",
      wait_ms: u.searchParams.get("wait_ms")
        ? Number(u.searchParams.get("wait_ms"))
        : undefined,
      no_stealth: u.searchParams.get("no_stealth") === "true",
    };
  }
  if (!payload.url) return send(res, 400, { error: "url is required" });
  try {
    const result = await scrape(payload.url, toOptions(payload));
    send(res, 200, result);
  } catch (e) {
    send(res, 500, { error: (e as Error).message });
  }
}

const server = createServer(async (req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    return res.end();
  }
  if (path === "/health") return send(res, 200, { ok: true });
  if (path === "/scrape") return handleScrape(req, res);
  send(res, 404, { error: "not found", paths: ["/scrape", "/health"] });
});

server.listen(PORT, HOST, () => {
  console.error(`[geom-scraper-server] listening on http://${HOST}:${PORT}`);
  console.error(
    `  GET  http://${HOST}:${PORT}/scrape?url=https://...&preset=generic`,
  );
  console.error(`  POST http://${HOST}:${PORT}/scrape  {"url":"...", "preset":"..."}`);
});
