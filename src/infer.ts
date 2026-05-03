import type { NormalizedNode } from "./normalize.js";

export type Preset = "shopping" | "generic" | "raw";

export interface ExtractedShopping {
  title: string | null;
  price: string | null;
  image: string | null;
  url: string | null;
}

export interface LinkInfo {
  text: string;
  href: string;
}

export interface ExtractedGeneric {
  image: string | null;
  primaryText: string | null;
  secondaryText: string | null;
  meta: string[];
  links: LinkInfo[];
  url: string | null;
}

export interface ExtractedRaw {
  texts: string[];
  images: string[];
  links: LinkInfo[];
}

export type Extracted = ExtractedShopping | ExtractedGeneric | ExtractedRaw;

const PRICE_RE = /(?:[¥￥$€£]\s*\d[\d,.\s]*|\d[\d,]{2,}\s*円|\d[\d,]+\s*(?:USD|JPY|EUR))/i;
const POINT_RE = /(?:ポイント|points?|pt)/i;
const MIN_IMAGE_PX = 50; // バッジ・SVGアイコン除外
const META_MAX = 6;
const LINK_MAX = 12;

function digitDensity(s: string): number {
  if (!s) return 0;
  const digits = s.replace(/[^0-9]/g, "").length;
  return digits / s.length;
}

function tidy(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function descendantsOf(
  root: NormalizedNode,
  byParent: Map<number | null, NormalizedNode[]>,
): NormalizedNode[] {
  const out: NormalizedNode[] = [];
  const stack: NormalizedNode[] = [root];
  const seen = new Set<number>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur.id)) continue;
    seen.add(cur.id);
    if (cur.id !== root.id) out.push(cur);
    const kids = byParent.get(cur.id) ?? [];
    for (const k of kids) stack.push(k);
  }
  return out;
}

function pickImage(desc: NormalizedNode[]): NormalizedNode | null {
  const imgs = desc
    .filter(
      (n) =>
        n.hasImage &&
        n.imgSrc &&
        !/\.svg(\?|$)/i.test(n.imgSrc) &&
        n.w >= MIN_IMAGE_PX &&
        n.h >= MIN_IMAGE_PX,
    )
    .sort((a, b) => b.areaRatio - a.areaRatio);
  return imgs[0] ?? null;
}

function pickPrimary(
  desc: NormalizedNode[],
  card: NormalizedNode,
): NormalizedNode | null {
  const cardTop = card.y;
  const cardH = card.h || 1;
  const candidates = desc
    .filter(
      (n) =>
        n.textLength >= 5 &&
        n.textLength <= 200 &&
        n.text.trim().length > 0 &&
        !PRICE_RE.test(n.text),
    )
    .map((n) => {
      const verticalPos = (n.y - cardTop) / cardH;
      let score = 0;
      if (n.isLink) score += 3;
      if (verticalPos < 0.6) score += 2;
      if (n.textLength >= 10 && n.textLength <= 100) score += 2;
      if (/^[A-Z]/.test(n.text) || /[ぁ-んァ-ヶ一-龯]/.test(n.text)) score += 1;
      if (/^H[1-6]$/.test(n.tag)) score += 3; // 見出しタグは強い手がかり
      // 数字密度高すぎるテキストは見出しらしくない
      if (digitDensity(n.text) > 0.5) score -= 2;
      return { n, score };
    })
    .sort((a, b) => b.score - a.score || a.n.y - b.n.y);
  return candidates[0]?.n ?? null;
}

function pickSecondary(
  desc: NormalizedNode[],
  primary: NormalizedNode | null,
): NormalizedNode | null {
  const candidates = desc
    .filter(
      (n) =>
        primary == null || (n.id !== primary.id && !isAncestorOf(n, primary)),
    )
    .filter(
      (n) =>
        n.textLength >= 30 &&
        n.textLength <= 400 &&
        digitDensity(n.text) < 0.5,
    )
    .map((n) => {
      let score = 0;
      if (n.tag === "P") score += 2;
      if (n.textLength >= 50 && n.textLength <= 250) score += 2;
      if (n.isLink) score -= 1; // リンクなら primary 候補だった可能性が高い
      return { n, score };
    })
    .sort((a, b) => b.score - a.score || a.n.y - b.n.y);
  return candidates[0]?.n ?? null;
}

function isAncestorOf(a: NormalizedNode, b: NormalizedNode): boolean {
  // a の bbox が b を完全に内包し、面積も a >= b なら祖先寄り（厳密ではない近似）
  return (
    a.x <= b.x &&
    a.y <= b.y &&
    a.x + a.w >= b.x + b.w &&
    a.y + a.h >= b.y + b.h &&
    a.id !== b.id
  );
}

function pickPrice(desc: NormalizedNode[]): NormalizedNode | null {
  const candidates = desc
    .filter((n) => n.text && n.textLength <= 80)
    .map((n) => {
      let score = 0;
      if (PRICE_RE.test(n.text)) score += 5;
      if (digitDensity(n.text) > 0.3) score += 2;
      if (/[¥￥$€£円]/.test(n.text)) score += 2;
      if (POINT_RE.test(n.text)) score -= 4;
      return { n, score };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);
  return candidates[0]?.n ?? null;
}

function pickLink(
  desc: NormalizedNode[],
  card: NormalizedNode,
): NormalizedNode | null {
  if (card.isLink && card.href) return card;
  const links = desc
    .filter((n) => n.isLink && n.href)
    .sort((a, b) => b.areaRatio - a.areaRatio);
  return links[0] ?? null;
}

function collectLinks(
  desc: NormalizedNode[],
  card: NormalizedNode,
): LinkInfo[] {
  const all = (card.isLink && card.href ? [card] : []).concat(
    desc.filter((n) => n.isLink && n.href),
  );
  const seen = new Set<string>();
  const out: LinkInfo[] = [];
  for (const n of all) {
    if (!n.href || seen.has(n.href)) continue;
    seen.add(n.href);
    out.push({ text: tidy(n.text), href: n.href });
    if (out.length >= LINK_MAX) break;
  }
  return out;
}

function collectMeta(
  desc: NormalizedNode[],
  excludeIds: Set<number>,
): string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  // 短文 (1-40字) かつ excludeIds に被らないものを y 順に集める
  const sorted = desc
    .filter(
      (n) =>
        !excludeIds.has(n.id) &&
        n.text &&
        n.textLength >= 1 &&
        n.textLength <= 40,
    )
    .sort((a, b) => a.y - b.y || a.x - b.x);
  for (const n of sorted) {
    const t = tidy(n.text);
    if (!t || seen.has(t)) continue;
    // 親要素の text と完全一致するテキスト (= 子の文字を全部含むケース) を除外
    seen.add(t);
    items.push(t);
    if (items.length >= META_MAX) break;
  }
  return items;
}

function inferShopping(
  card: NormalizedNode,
  desc: NormalizedNode[],
): ExtractedShopping {
  const image = pickImage(desc);
  const title = pickPrimary(desc, card);
  const price = pickPrice(desc);
  const link = pickLink(desc, card);
  let priceOut: string | null = null;
  if (price) {
    const compact = price.text.replace(/\s+/g, "");
    const m = compact.match(PRICE_RE);
    priceOut = m ? m[0] : compact;
  }
  return {
    title: title ? tidy(title.text) : null,
    price: priceOut,
    image: image?.imgSrc ?? null,
    url: link?.href ?? null,
  };
}

function inferGeneric(
  card: NormalizedNode,
  desc: NormalizedNode[],
): ExtractedGeneric {
  const image = pickImage(desc);
  const primary = pickPrimary(desc, card);
  const secondary = pickSecondary(desc, primary);
  const link = pickLink(desc, card);
  const links = collectLinks(desc, card);
  const exclude = new Set<number>();
  if (primary) exclude.add(primary.id);
  if (secondary) exclude.add(secondary.id);
  const meta = collectMeta(desc, exclude);
  return {
    image: image?.imgSrc ?? null,
    primaryText: primary ? tidy(primary.text) : null,
    secondaryText: secondary ? tidy(secondary.text) : null,
    meta,
    links,
    url: link?.href ?? null,
  };
}

function inferRaw(
  card: NormalizedNode,
  desc: NormalizedNode[],
): ExtractedRaw {
  const texts: string[] = [];
  const seenText = new Set<string>();
  for (const n of desc) {
    if (!n.text) continue;
    const t = tidy(n.text);
    if (!t || seenText.has(t)) continue;
    seenText.add(t);
    texts.push(t);
  }
  const images = Array.from(
    new Set(
      desc
        .filter(
          (n) =>
            n.hasImage &&
            n.imgSrc &&
            !/\.svg(\?|$)/i.test(n.imgSrc) &&
            n.w >= MIN_IMAGE_PX &&
            n.h >= MIN_IMAGE_PX,
        )
        .map((n) => n.imgSrc!),
    ),
  );
  const links = collectLinks(desc, card);
  return { texts, images, links };
}

export function inferFields(
  card: NormalizedNode,
  byParent: Map<number | null, NormalizedNode[]>,
  preset: Preset = "generic",
): Extracted {
  const desc = descendantsOf(card, byParent);
  switch (preset) {
    case "shopping":
      return inferShopping(card, desc);
    case "raw":
      return inferRaw(card, desc);
    case "generic":
    default:
      return inferGeneric(card, desc);
  }
}

export function buildParentIndex(
  nodes: NormalizedNode[],
): Map<number | null, NormalizedNode[]> {
  const m = new Map<number | null, NormalizedNode[]>();
  for (const n of nodes) {
    const k = n.parentId;
    let arr = m.get(k);
    if (!arr) {
      arr = [];
      m.set(k, arr);
    }
    arr.push(n);
  }
  return m;
}
