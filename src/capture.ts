import { chromium, type Browser, type BrowserContext } from "playwright";
import { realpath, mkdir } from "node:fs/promises";
import { resolve as pathResolve, dirname as pathDirname, sep as pathSep, join as pathJoin } from "node:path";

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------
// Node.js URL.hostname returns IPv6 addresses wrapped in brackets, e.g. "[::1]".
// Each IPv6 pattern uses \[? prefix so it matches both the raw form and the
// bracketed form that URL parsing produces.
const PRIVATE_RANGES = [
  // IPv4 loopback
  /^127\./,
  // IPv4 unspecified
  /^0\.0\.0\.0/,
  // IPv4 link-local
  /^169\.254\./,
  // RFC1918
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  // RFC6598 CGNAT (100.64.0.0/10 — shared address space, off-limits for SSRF)
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  // S1: leading-zero (octal) IPv4 octets like 0177.0.0.1 — interpreters that
  // treat leading-zero octets as octal would resolve to private addresses.
  /^0\d+\./,
  // IPv6 loopback / unspecified — URL.hostname produces "[::1]" and "[::]"
  /^\[?::1\]?$/,
  /^\[?::\]?$/,
  // IPv6 link-local / ULA
  /^\[?fe80:/i,
  /^\[?fc/i,
  /^\[?fd/i,
  // IPv4-mapped IPv6 (::ffff:...) — blocked in full: Node normalises all
  // dotted-quad forms to hex so "::ffff:192.168.1.1" → "[::ffff:c0a8:101]".
  // Block the entire ::ffff: range; accepting public-IP-mapped addresses would
  // only make sense if we also checked the embedded IP, which is fragile.
  /^\[?::ffff:/i,
  // S2: NAT64 well-known prefix (64:ff9b::/96) — embeds IPv4 inside IPv6
  /^\[?64:ff9b:/i,
  // S1: NAT64 RFC 8215 local-use prefix (64:ff9b:1::/48)
  /^\[?64:ff9b:1:/i,
  // S2: IPv4-mapped form with explicit ::ffff:0:0/96 alternate notation
  /^\[?::ffff:0:/i,
];

// Plain "localhost" must also be blocked regardless of what it resolves to.
export function isPrivateHost(hostname: string): boolean {
  if (hostname === "localhost") return true;
  return PRIVATE_RANGES.some((re) => re.test(hostname));
}

export function validateUrl(raw: string): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`URL must use http: or https: scheme`);
  }
  // S2: explicit guard for octal IPv4 — only applies to pure dotted-quad
  // hostnames so domain names containing "0" are not falsely rejected.
  const parts = parsed.hostname.split(".");
  if (parts.length === 4 && parts.every(p => /^\d+$/.test(p)) && /(?:^|\.)0\d/.test(parsed.hostname)) {
    throw new Error("Octal IPv4 notation not allowed");
  }
  if (
    !process.env.GEOM_SCRAPER_ALLOW_PRIVATE &&
    isPrivateHost(parsed.hostname)
  ) {
    throw new Error(
      `Requests to private/loopback addresses are blocked. Set GEOM_SCRAPER_ALLOW_PRIVATE=1 to allow.`,
    );
  }
}

// S5: confine user-supplied output paths under GEOM_SCRAPER_OUTPUT_ROOT (default
// <cwd>/output). Resolves against realpath so symlinks can't escape the root.
function getOutputRoot(): string {
  return process.env.GEOM_SCRAPER_OUTPUT_ROOT
    ? pathResolve(process.env.GEOM_SCRAPER_OUTPUT_ROOT)
    : pathResolve(process.cwd(), "output");
}

export async function assertSafeRoot(target: string): Promise<string> {
  const root = getOutputRoot();
  await mkdir(root, { recursive: true });
  const realRoot = await realpath(root);
  const absTarget = pathResolve(target);
  // Walk up to the closest existing ancestor and realpath that — the file
  // itself may not exist yet.
  let probe = absTarget;
  // Bound the walk so a malformed path cannot loop indefinitely.
  for (let i = 0; i < 64; i++) {
    try {
      const realProbe = await realpath(probe);
      const rootWithSep = realRoot.endsWith(pathSep) ? realRoot : realRoot + pathSep;
      const suffix = probe === absTarget ? "" : absTarget.slice(probe.length);
      const realTarget = suffix ? pathJoin(realProbe, suffix) : realProbe;
      if (realTarget !== realRoot && !realTarget.startsWith(rootWithSep)) {
        throw new Error(
          `Path "${target}" escapes GEOM_SCRAPER_OUTPUT_ROOT (${realRoot})`,
        );
      }
      return absTarget;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const parent = pathDirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  throw new Error(`Could not resolve safe root for path "${target}"`);
}

export interface RawNode {
  id: number;
  parentId: number | null;
  tag: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  textLength: number;
  hasImage: boolean;
  isLink: boolean;
  href: string | null;
  imgSrc: string | null;
  childCount: number;
  childTags: string[];
}

export interface CaptureResult {
  url: string;
  viewport: { width: number; height: number };
  nodes: RawNode[];
}

export interface CaptureOptions {
  viewport?: { width: number; height: number };
  waitMs?: number;
  userAgent?: string;
  locale?: string;
  timezoneId?: string;
  stealth?: boolean; // 既定 true
  headless?: boolean; // 既定 true
  networkIdle?: boolean; // 既定 true。SPA向け
  screenshotPath?: string; // 指定時にスクショ保存
  rawNodesPath?: string; // 指定時に生nodes JSON保存
}

// U8: derive UA from the launched browser's reported version so it stays in
// sync with whatever Chromium Playwright ships, rather than drifting as a
// hard-coded constant. browser.version() returns e.g. "131.0.6778.33".
function buildUaFromVersion(ver: string): string {
  const major = ver.split(".")[0] ?? "131";
  return (
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
    `(KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
  );
}

async function applyStealth(context: BrowserContext): Promise<void> {
  // headless 検知の代表的シグナルを潰す軽量パッチ
  await context.addInitScript(() => {
    // navigator.webdriver
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });

    // navigator.languages
    Object.defineProperty(navigator, "languages", {
      get: () => ["ja-JP", "ja", "en-US", "en"],
    });

    // navigator.plugins (空配列対策)
    Object.defineProperty(navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5],
    });

    // chrome オブジェクト
    // @ts-expect-error - Chrome独自プロパティ
    window.chrome = window.chrome ?? { runtime: {} };

    // permissions.query が notifications を返す挙動の差異
    const originalQuery = window.navigator.permissions?.query;
    if (originalQuery) {
      window.navigator.permissions.query = (
        params: PermissionDescriptor,
      ): Promise<PermissionStatus> =>
        params.name === "notifications"
          ? Promise.resolve({
              state: Notification.permission,
            } as PermissionStatus)
          : originalQuery(params);
    }

    // WebGL ベンダー / レンダラー
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (parameter) {
      if (parameter === 37445) return "Intel Inc."; // UNMASKED_VENDOR_WEBGL
      if (parameter === 37446) return "Intel Iris OpenGL Engine"; // UNMASKED_RENDERER_WEBGL
      return getParameter.apply(this, [parameter]);
    };
  });
}

export async function capture(
  url: string,
  opts: CaptureOptions = {},
): Promise<CaptureResult> {
  // S1: defensive SSRF guard (primary guard is in server.ts / mcp.ts)
  validateUrl(url);
  const viewport = opts.viewport ?? { width: 1440, height: 900 };
  const stealth = opts.stealth ?? true;
  const headless = opts.headless ?? true;
  let browser: Browser | null = null;
  try {
    // S8: --no-sandbox only when explicitly opted in (e.g. Docker root)
    const launchArgs = [
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
    ];
    if (process.env.GEOM_SCRAPER_NO_SANDBOX === "1") {
      launchArgs.push("--no-sandbox");
    }
    browser = await chromium.launch({
      headless,
      args: launchArgs,
    });
    // S6: strip control chars from user-supplied UA so callers can't inject
    // CR/LF/etc into the request line via Playwright's userAgent.
    // U8: when no caller UA, derive from browser.version() to avoid drift.
    const safeUa = (opts.userAgent ?? buildUaFromVersion(browser.version())).replace(/[\x00-\x1f]/g, "");
    // S5: pre-validate any user-supplied output paths before launching the
    // browser so we don't waste a launch on a path that will be rejected.
    if (opts.screenshotPath) await assertSafeRoot(opts.screenshotPath);
    if (opts.rawNodesPath) await assertSafeRoot(opts.rawNodesPath);
    const context = await browser.newContext({
      viewport,
      userAgent: safeUa,
      locale: opts.locale ?? "ja-JP",
      timezoneId: opts.timezoneId ?? "Asia/Tokyo",
      extraHTTPHeaders: {
        "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
      },
    });
    // tsx/esbuild が evaluate 内の named function を __name() でラップするため
    // ブラウザ側に __name が無いと ReferenceError になる。stealth と独立して常時注入する。
    await context.addInitScript(() => {
      // @ts-expect-error - esbuild helper polyfill
      globalThis.__name = globalThis.__name ?? ((fn) => fn);
    });

    if (stealth) await applyStealth(context);

    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });

    // SPA 等の遅延レンダリング対策：networkidle 待ち（タイムアウトしても続行）
    if (opts.networkIdle ?? true) {
      try {
        await page.waitForLoadState("networkidle", { timeout: 8_000 });
      } catch (e: unknown) {
        // B6: only swallow timeouts; rethrow other errors (e.g. context closed)
        if (!(e instanceof Error) || e.name !== "TimeoutError") throw e;
        // 広告/トラッキングが繋ぎっぱなしのサイトは諦めて続行
      }
    }

    // 遅延ロード対策のスクロール（最後まで降りてから戻す）
    // B1: end-of-page check uses real scrollY+innerHeight vs body.scrollHeight
    // (with a small tolerance) so the final viewport actually renders before we
    // exit the loop. The previous y-counter could exit early on tall pages
    // because document.body.scrollHeight grows as content lazy-loads.
    await page.evaluate(async () => {
      await new Promise<void>((resolve) => {
        if (!document.body) { resolve(); return; }
        let iterations = 0;
        const MAX_ITER = 50;
        const step = 600;
        const TOLERANCE = 4;
        const timer = setInterval(() => {
          iterations++;
          window.scrollBy(0, step);
          const reachedEnd =
            window.scrollY + window.innerHeight >=
            document.body.scrollHeight - TOLERANCE;
          if (reachedEnd || iterations >= MAX_ITER) {
            clearInterval(timer);
            resolve();
          }
        }, 80);
      });
    });
    // 画像の lazy load を発火させてからトップへ戻す（unload 防止に少し待つ）
    // S7: clamp wait_ms to 30s max
    await page.waitForTimeout(Math.min(opts.waitMs ?? 1500, 30_000));
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);

    if (opts.screenshotPath) {
      await page.screenshot({ path: opts.screenshotPath, fullPage: true });
    }

    const nodes = await page.evaluate(() => {
      const out: Array<Record<string, unknown>> = [];
      const idMap = new Map<Element, number>();
      const all = Array.from(document.querySelectorAll("body *"));
      all.forEach((el, i) => idMap.set(el, i));

      const abs = (raw: string | null | undefined): string | null => {
        if (!raw) return null;
        try {
          return new URL(raw, location.href).href;
        } catch {
          return raw;
        }
      };

      // <img> の src/srcset/data-src を最大解像度優先で解決
      const pickImgSrc = (img: HTMLImageElement | null): string | null => {
        if (!img) return null;
        const srcset = img.getAttribute("srcset");
        if (srcset) {
          // "url 1x, url 2x" の最後を採用（だいたい高解像度）
          const last = srcset
            .split(",")
            .map((s) => s.trim().split(/\s+/)[0])
            .filter(Boolean)
            .pop();
          if (last) return abs(last);
        }
        return abs(
          img.currentSrc ||
            img.getAttribute("src") ||
            img.getAttribute("data-src") ||
            img.getAttribute("data-original"),
        );
      };

      for (const el of all) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const style = window.getComputedStyle(el);
        if (
          style.visibility === "hidden" ||
          style.display === "none" ||
          parseFloat(style.opacity) === 0
        ) {
          continue;
        }
        const text = (el as HTMLElement).innerText?.trim() ?? "";
        const img = el.querySelector("img");
        const link = el.tagName === "A" ? (el as HTMLAnchorElement) : null;
        const childTags: string[] = [];
        for (const c of Array.from(el.children)) childTags.push(c.tagName);

        out.push({
          id: idMap.get(el),
          parentId:
            el.parentElement && idMap.has(el.parentElement)
              ? idMap.get(el.parentElement)
              : null,
          tag: el.tagName,
          x: r.x,
          y: r.y + window.scrollY,
          w: r.width,
          h: r.height,
          text: text.slice(0, 200),
          textLength: text.length,
          hasImage: !!img,
          isLink: !!link,
          href: link ? abs(link.getAttribute("href")) : null,
          imgSrc: pickImgSrc(img),
          childCount: el.children.length,
          childTags,
        });
      }
      return out as unknown as RawNode[];
    });

    if (opts.rawNodesPath) {
      const { writeFile, mkdir, rename, unlink } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      await mkdir(dirname(opts.rawNodesPath), { recursive: true });
      // S12: write to a .tmp sibling then atomically rename so readers never
      // see a partial file if the process crashes mid-write.
      const tmpPath = `${opts.rawNodesPath}.tmp`;
      await writeFile(
        tmpPath,
        JSON.stringify({ url, viewport, nodes }, null, 2),
        "utf8",
      );
      // B3: if rename fails (e.g. cross-device), clean up the .tmp orphan
      // before propagating so we don't leave debris behind.
      try {
        await rename(tmpPath, opts.rawNodesPath);
      } catch (e) {
        await unlink(tmpPath).catch(() => undefined);
        throw e;
      }
    }

    return { url, viewport, nodes };
  } finally {
    // B1: nested try-catch so browser.close() failure doesn't swallow original error
    if (browser) {
      try {
        await browser.close();
      } catch (closeErr) {
        console.error("[geom-scraper] browser.close() failed:", closeErr);
      }
    }
  }
}
