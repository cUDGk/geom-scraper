import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { scrape, type ScrapeOptions } from "./extract.js";
import type { Preset } from "./infer.js";
import { validateUrl } from "./capture.js";

const PORT = Number(process.env.PORT ?? 8765);
if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
  console.error(`[geom-scraper] FATAL: PORT="${process.env.PORT}" is not a valid port number (1-65535)`);
  process.exit(1);
}
const HOST = process.env.HOST ?? "127.0.0.1";

// S2: optional bearer token auth
const API_TOKEN = process.env.GEOM_SCRAPER_API_TOKEN;

// S3: concurrency cap
const MAX_CONCURRENT = Number(process.env.GEOM_SCRAPER_MAX_CONCURRENT ?? 3);
let inFlight = 0;

// S4: CORS — default no CORS; allow specific origin via env. Reject the
// wildcard "*" at startup: with credentials/auth in scope, a wildcard ACAO
// is unsafe and almost certainly a misconfiguration.
const CORS_ORIGIN = process.env.GEOM_SCRAPER_CORS_ORIGIN;
if (CORS_ORIGIN === "*") {
  console.error(
    "[geom-scraper] FATAL: GEOM_SCRAPER_CORS_ORIGIN=* is unsafe. Use a specific origin or omit this env var.",
  );
  process.exit(1);
}

// S6: body size limit
const BODY_LIMIT = 64 * 1024; // 64 KiB

const PRESETS: Preset[] = ["shopping", "generic", "raw"];

interface ScrapeRequest {
  url?: string;
  preset?: Preset;
  group_index?: number;
  all_groups?: boolean;
  wait_ms?: number;
  // S9: no_stealth removed from HTTP API surface; stealth is server-side only
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  req?: IncomingMessage,
): void {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
  };
  // S4: only emit ACAO when the request's Origin matches the configured
  // CORS_ORIGIN exactly. Always set Vary: Origin when CORS is configured so
  // caches don't conflate cross-origin and same-origin responses.
  if (CORS_ORIGIN) {
    headers["vary"] = "Origin";
    const reqOrigin = req?.headers.origin;
    if (reqOrigin && reqOrigin === CORS_ORIGIN) {
      headers["access-control-allow-origin"] = CORS_ORIGIN;
    }
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  // S6: track accumulated bytes; reject after 64 KiB
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const buf = c as Buffer;
    total += buf.length;
    if (total > BODY_LIMIT) {
      throw Object.assign(new Error("Request body too large"), { statusCode: 413 });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function toOptions(p: ScrapeRequest): ScrapeOptions {
  return {
    preset: p.preset,
    groupIndex: p.group_index,
    // B3: use === true (not Boolean()) so the overload narrowing works — Boolean()
    // returns `boolean`, which doesn't narrow to `true` for TypeScript overloads.
    allGroups: p.all_groups === true,
    waitMs: p.wait_ms,
    // screenshotPath / rawNodesPath intentionally excluded from HTTP surface (S5)
  };
}

// S11: use timingSafeEqual to prevent timing-based token enumeration
const API_TOKEN_BUF = API_TOKEN
  ? Buffer.from(`Bearer ${API_TOKEN}`, "utf8")
  : null;

function checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (!API_TOKEN_BUF) return true; // auth not configured
  // S3: always run timingSafeEqual against a length-padded buffer, regardless
  // of whether the incoming header is shorter or longer than the secret. We
  // separately track the length match: lenOk && bytesOk is the only success
  // path. Running the compare unconditionally avoids leaking length via timing.
  const incoming = Buffer.from(req.headers.authorization ?? "", "utf8");
  const padded = Buffer.alloc(API_TOKEN_BUF.length);
  incoming.copy(padded, 0, 0, Math.min(incoming.length, padded.length));
  const lenOk = incoming.length === API_TOKEN_BUF.length;
  const bytesOk = timingSafeEqual(padded, API_TOKEN_BUF);
  if (lenOk && bytesOk) return true;
  send(res, 401, { error: "unauthorized" }, req);
  return false;
}

async function handleScrape(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // B11: entire handler wrapped in try/catch
  let payload: ScrapeRequest = {};
  try {
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
      // B9: use fixed base instead of req.headers.host to avoid header injection
      const u = new URL(req.url ?? "/", "http://localhost");
      payload = {
        url: u.searchParams.get("url") ?? undefined,
        preset: (u.searchParams.get("preset") as Preset) ?? undefined,
        group_index: u.searchParams.get("group_index")
          ? Number(u.searchParams.get("group_index"))
          : undefined,
        // B5: only set all_groups when the param is actually present, so the
        // query string `?...` (no all_groups) leaves it undefined rather than
        // forcing a single-group response when the caller meant "default".
        all_groups: u.searchParams.has("all_groups")
          ? u.searchParams.get("all_groups") === "true"
          : undefined,
        wait_ms: u.searchParams.get("wait_ms")
          ? Number(u.searchParams.get("wait_ms"))
          : undefined,
      };
    }

    if (!payload.url) return send(res, 400, { error: "url is required" }, req);

    // B10: validate preset against actual enum
    if (payload.preset !== undefined && !PRESETS.includes(payload.preset)) {
      return send(res, 400, {
        error: `invalid preset "${payload.preset}". allowed: ${PRESETS.join(", ")}`,
      }, req);
    }

    // S1: SSRF guard
    try {
      validateUrl(payload.url);
    } catch (e) {
      return send(res, 400, { error: (e as Error).message }, req);
    }

    const result = await scrape(payload.url, toOptions(payload));
    send(res, 200, result, req);
  } catch (e) {
    const err = e as Error & { statusCode?: number };
    const statusCode = err.statusCode ?? 500;
    // S10: log full error to stderr, return generic message to client
    const reqId = randomUUID();
    console.error(`[geom-scraper] request ${reqId} error:`, e);
    if (statusCode === 413) {
      send(res, 413, { error: "request body too large", requestId: reqId }, req);
    } else if (err.message === "scrape timeout") {
      // B4: top-level 60s timeout — surface as 504 rather than generic 500
      send(res, 504, { error: "scrape timed out", requestId: reqId }, req);
    } else {
      send(res, 500, { error: "internal error", requestId: reqId }, req);
    }
  }
}

// B4: hard 60s ceiling on /scrape so a hung browser can't block forever. The
// AbortController is passed so future Playwright versions can hook into it; in
// the meantime the timeout simply rejects the wrapping promise — the finally
// block in capture() still tears the browser down.
const SCRAPE_TIMEOUT_MS = Number(
  process.env.GEOM_SCRAPER_SCRAPE_TIMEOUT_MS ?? 60_000,
);

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("scrape timeout")), ms);
    t.unref();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

const server = createServer(async (req, res) => {
  const path = (req.url ?? "/").split("?")[0];

  // S3: auth check (skip /health) — must run before CORS preflight so
  // unauthenticated OPTIONS requests don't leak CORS headers.
  if (path !== "/health" && !checkAuth(req, res)) return;

  // S4: CORS preflight (after auth gate)
  if (req.method === "OPTIONS") {
    const headers: Record<string, string> = {
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, authorization",
    };
    if (CORS_ORIGIN) {
      headers["access-control-allow-origin"] = CORS_ORIGIN;
      headers["vary"] = "Origin";
    }
    res.writeHead(204, headers);
    return res.end();
  }

  if (path === "/health") return send(res, 200, { ok: true }, req);

  // S3: concurrency cap
  if (inFlight >= MAX_CONCURRENT) {
    return send(res, 429, { error: "too many concurrent requests" }, req);
  }

  if (path === "/scrape") {
    inFlight++;
    try {
      // B4: race the handler against a 60s timeout. handleScrape catches its
      // own errors and writes a response; the timeout path also writes one if
      // handleScrape hadn't responded yet.
      await withTimeout(handleScrape(req, res), SCRAPE_TIMEOUT_MS).catch((e) => {
        if ((e as Error).message === "scrape timeout" && !res.headersSent) {
          const reqId = randomUUID();
          console.error(`[geom-scraper] request ${reqId} timed out after ${SCRAPE_TIMEOUT_MS}ms`);
          send(res, 504, { error: "scrape timed out", requestId: reqId }, req);
        }
      });
      return;
    } finally {
      inFlight--;
    }
  }

  send(res, 404, { error: "not found", paths: ["/scrape", "/health"] }, req);
});

server.listen(PORT, HOST, () => {
  console.error(`[geom-scraper-server] listening on http://${HOST}:${PORT}`);
  console.error(
    `  GET  http://${HOST}:${PORT}/scrape?url=https://...&preset=generic`,
  );
  console.error(`  POST http://${HOST}:${PORT}/scrape  {"url":"...", "preset":"..."}`);
});
