import { capture, type CaptureOptions } from "./capture.js";
import { normalize } from "./normalize.js";
import { clusterCards, type CardGroup } from "./cluster.js";
import {
  buildParentIndex,
  inferFields,
  type Extracted,
  type Preset,
} from "./infer.js";

export interface GroupSummary {
  cardCount: number;
  fingerprint: string;
}

export interface ScrapeResult {
  url: string;
  preset: Preset;
  groupCount: number;
  cardCount: number;
  fingerprint: string;
  groupSummaries: GroupSummary[];
  items: Extracted[];
  // U4: surfaced when the requested groupIndex was clamped, etc.
  note?: string;
}

export interface ScrapeOptions extends CaptureOptions {
  groupIndex?: number; // どのカードグループを採用するか（既定: 最上位 0）
  allGroups?: boolean; // 全グループ返す場合
  preset?: Preset; // 既定 "generic"
}

// B3: explicit overloads so callers get the right return type
export async function scrape(
  url: string,
  opts: ScrapeOptions & { allGroups: true },
): Promise<ScrapeResult[]>;
export async function scrape(
  url: string,
  opts?: ScrapeOptions,
): Promise<ScrapeResult>;
export async function scrape(
  url: string,
  opts: ScrapeOptions = {},
): Promise<ScrapeResult | ScrapeResult[]> {
  const cap = await capture(url, opts);
  const norm = normalize(cap);
  const groups = clusterCards(norm);
  const byParent = buildParentIndex(norm.nodes);

  const groupSummaries: GroupSummary[] = groups.map((g) => ({
    cardCount: g.cards.length,
    fingerprint: g.fingerprint,
  }));
  const preset: Preset = opts.preset ?? "generic";

  const toResult = (g: CardGroup): ScrapeResult => ({
    url: cap.url,
    preset,
    groupCount: groups.length,
    cardCount: g.cards.length,
    fingerprint: g.fingerprint,
    groupSummaries,
    items: g.cards.map((c) => inferFields(c, byParent, preset)),
  });

  if (opts.allGroups) return groups.map(toResult);
  if (groups.length === 0) {
    return {
      url: cap.url,
      preset,
      groupCount: 0,
      cardCount: 0,
      fingerprint: "",
      groupSummaries: [],
      items: [],
    };
  }
  // B4: clamp groupIndex and note when it was clamped
  const rawIdx = opts.groupIndex ?? 0;
  const idx = Math.min(rawIdx, groups.length - 1);
  const result = toResult(groups[idx]!);
  if (rawIdx > idx) {
    result.note = `groupIndex ${rawIdx} out of range; clamped to ${idx} (groupCount=${groups.length})`;
  }
  return result;
}
