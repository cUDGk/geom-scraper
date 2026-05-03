import { chromium, type Browser } from "playwright";

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
}

export async function capture(
  url: string,
  opts: CaptureOptions = {},
): Promise<CaptureResult> {
  const viewport = opts.viewport ?? { width: 1440, height: 900 };
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport,
      userAgent:
        opts.userAgent ??
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    // 遅延ロード対策の軽いスクロール
    await page.evaluate(async () => {
      await new Promise<void>((resolve) => {
        let y = 0;
        const step = 600;
        const timer = setInterval(() => {
          window.scrollBy(0, step);
          y += step;
          if (y >= document.body.scrollHeight) {
            clearInterval(timer);
            window.scrollTo(0, 0);
            resolve();
          }
        }, 80);
      });
    });
    await page.waitForTimeout(opts.waitMs ?? 800);

    const nodes = await page.evaluate(() => {
      const out: Array<Record<string, unknown>> = [];
      const idMap = new Map<Element, number>();
      const all = Array.from(document.querySelectorAll("body *"));
      all.forEach((el, i) => idMap.set(el, i));

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
          href: link?.href ?? null,
          imgSrc: img?.getAttribute("src") ?? null,
          childCount: el.children.length,
          childTags,
        });
      }
      return out as unknown as RawNode[];
    });

    return { url, viewport, nodes };
  } finally {
    if (browser) await browser.close();
  }
}
