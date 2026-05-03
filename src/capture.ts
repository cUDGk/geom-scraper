import { chromium, type Browser, type BrowserContext } from "playwright";

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

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

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
  const viewport = opts.viewport ?? { width: 1440, height: 900 };
  const stealth = opts.stealth ?? true;
  const headless = opts.headless ?? true;
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      headless,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-dev-shm-usage",
      ],
    });
    const context = await browser.newContext({
      viewport,
      userAgent: opts.userAgent ?? DEFAULT_UA,
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
      } catch {
        // 広告/トラッキングが繋ぎっぱなしのサイトは諦めて続行
      }
    }

    // 遅延ロード対策のスクロール（最後まで降りてから戻す）
    await page.evaluate(async () => {
      await new Promise<void>((resolve) => {
        let y = 0;
        const step = 600;
        const timer = setInterval(() => {
          window.scrollBy(0, step);
          y += step;
          if (y >= document.body.scrollHeight) {
            clearInterval(timer);
            resolve();
          }
        }, 80);
      });
    });
    // 画像の lazy load を発火させてからトップへ戻す（unload 防止に少し待つ）
    await page.waitForTimeout(opts.waitMs ?? 1500);
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
      const { writeFile, mkdir } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      await mkdir(dirname(opts.rawNodesPath), { recursive: true });
      await writeFile(
        opts.rawNodesPath,
        JSON.stringify({ url, viewport, nodes }, null, 2),
        "utf8",
      );
    }

    return { url, viewport, nodes };
  } finally {
    if (browser) await browser.close();
  }
}
