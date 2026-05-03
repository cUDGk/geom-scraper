import { capture, type CaptureOptions } from "./capture.js";
import { normalize } from "./normalize.js";
import { clusterCards, type CardGroup } from "./cluster.js";
import { buildParentIndex, inferFields, type Extracted } from "./infer.js";

export interface ScrapeResult {
  url: string;
  groupCount: number;
  cardCount: number;
  fingerprint: string;
  items: Extracted[];
}

export interface ScrapeOptions extends CaptureOptions {
  groupIndex?: number; // どのカードグループを採用するか（既定: 最上位 0）
  allGroups?: boolean; // 全グループ返す場合
}

export async function scrape(
  url: string,
  opts: ScrapeOptions = {},
): Promise<ScrapeResult | ScrapeResult[]> {
  const cap = await capture(url, opts);
  const norm = normalize(cap);
  const groups = clusterCards(norm);
  const byParent = buildParentIndex(norm.nodes);

  const toResult = (g: CardGroup): ScrapeResult => ({
    url: cap.url,
    groupCount: groups.length,
    cardCount: g.cards.length,
    fingerprint: g.fingerprint,
    items: g.cards.map((c) => inferFields(c, byParent)),
  });

  if (opts.allGroups) return groups.map(toResult);
  if (groups.length === 0) {
    return {
      url: cap.url,
      groupCount: 0,
      cardCount: 0,
      fingerprint: "",
      items: [],
    };
  }
  const idx = Math.min(opts.groupIndex ?? 0, groups.length - 1);
  return toResult(groups[idx]);
}
