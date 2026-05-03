import type { NormalizedCapture, NormalizedNode } from "./normalize.js";

export interface CardGroup {
  parentId: number | null;
  fingerprint: string;
  cards: NormalizedNode[];
}

const MIN_CARDS_PER_GROUP = 3;
const MIN_CARD_AREA_RATIO = 0.005; // viewport の 0.5% 以上
const MAX_CARD_AREA_RATIO = 0.5;   // viewport の 50% 未満

function bucketAspect(ar: number): string {
  if (ar < 0.5) return "tall";
  if (ar < 1.2) return "square";
  if (ar < 2.5) return "wide";
  return "banner";
}

function bucketTextLen(len: number): string {
  if (len === 0) return "t0";
  if (len < 30) return "t1";
  if (len < 120) return "t2";
  if (len < 400) return "t3";
  return "t4";
}

function fingerprintOf(n: NormalizedNode): string {
  const tagSig = [...n.childTags].sort().join(",");
  return [
    n.tag,
    `c${n.childCount}`,
    n.hasImage ? "img" : "noimg",
    bucketAspect(n.aspectRatio),
    bucketTextLen(n.textLength),
    tagSig,
  ].join("|");
}

export function clusterCards(cap: NormalizedCapture): CardGroup[] {
  const eligible = cap.nodes.filter(
    (n) =>
      n.areaRatio >= MIN_CARD_AREA_RATIO &&
      n.areaRatio <= MAX_CARD_AREA_RATIO &&
      n.childCount >= 1,
  );

  // (parentId, fingerprint) で集約
  const buckets = new Map<string, CardGroup>();
  for (const n of eligible) {
    const fp = fingerprintOf(n);
    const key = `${n.parentId}::${fp}`;
    let g = buckets.get(key);
    if (!g) {
      g = { parentId: n.parentId, fingerprint: fp, cards: [] };
      buckets.set(key, g);
    }
    g.cards.push(n);
  }

  const groups = [...buckets.values()].filter(
    (g) => g.cards.length >= MIN_CARDS_PER_GROUP,
  );

  // カード数 × カード平均面積 でスコアリングして「メインの一覧」を上位に
  groups.sort((a, b) => {
    const sa =
      a.cards.length *
      (a.cards.reduce((s, c) => s + c.areaRatio, 0) / a.cards.length);
    const sb =
      b.cards.length *
      (b.cards.reduce((s, c) => s + c.areaRatio, 0) / b.cards.length);
    return sb - sa;
  });

  // 各グループのカードを y, x 順に並べる（読み順）
  for (const g of groups) {
    g.cards.sort((a, b) => a.y - b.y || a.x - b.x);
  }

  return groups;
}
