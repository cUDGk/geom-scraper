import type { NormalizedNode } from "./normalize.js";

export interface Extracted {
  title: string | null;
  price: string | null;
  image: string | null;
  url: string | null;
}

const PRICE_RE = /(?:[¥￥$€£]\s*\d[\d,.\s]*|\d[\d,]{2,}\s*円|\d[\d,]+\s*(?:USD|JPY|EUR))/i;
const POINT_RE = /(?:ポイント|points?|pt)/i;
const MIN_IMAGE_PX = 50; // バッジ・SVGアイコン除外

function digitDensity(s: string): number {
  if (!s) return 0;
  const digits = s.replace(/[^0-9]/g, "").length;
  return digits / s.length;
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

function pickTitle(
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
      const verticalPos = (n.y - cardTop) / cardH; // 0=top, 1=bottom
      // タイトルらしさ: リンク優先、上半分にあるほど高得点、適度な文字長
      let score = 0;
      if (n.isLink) score += 3;
      if (verticalPos < 0.6) score += 2;
      if (n.textLength >= 10 && n.textLength <= 80) score += 2;
      if (/^[A-Z]/.test(n.text) || /[ぁ-んァ-ヶ一-龯]/.test(n.text)) score += 1;
      // ヘディングタグなら加点
      if (/^H[1-6]$/.test(n.tag)) score += 2;
      return { n, score };
    })
    .sort((a, b) => b.score - a.score || a.n.y - b.n.y);
  return candidates[0]?.n ?? null;
}

function pickPrice(desc: NormalizedNode[]): NormalizedNode | null {
  const candidates = desc
    .filter((n) => n.text && n.textLength <= 80)
    .map((n) => {
      let score = 0;
      if (PRICE_RE.test(n.text)) score += 5;
      if (digitDensity(n.text) > 0.3) score += 2;
      if (/[¥￥$€£円]/.test(n.text)) score += 2;
      if (POINT_RE.test(n.text)) score -= 4; // 「298ポイント(1%)」を価格と誤認しない
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

export function inferFields(
  card: NormalizedNode,
  byParent: Map<number | null, NormalizedNode[]>,
): Extracted {
  const desc = descendantsOf(card, byParent);
  const image = pickImage(desc);
  const title = pickTitle(desc, card);
  const price = pickPrice(desc);
  const link = pickLink(desc, card);
  // price は match した部分だけ抽出して送料・ポイント等のノイズを落とす
  let priceOut: string | null = null;
  if (price) {
    const compact = price.text.replace(/\s+/g, "");
    const m = compact.match(PRICE_RE);
    priceOut = m ? m[0] : compact;
  }

  return {
    title: title?.text.replace(/\s+/g, " ").trim() ?? null,
    price: priceOut,
    image: image?.imgSrc ?? null,
    url: link?.href ?? null,
  };
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
