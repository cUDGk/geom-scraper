import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "node:module";
import { z } from "zod";
import { scrape } from "./extract.js";
import { validateUrl } from "./capture.js";

// U3: read version from package.json so the MCP version stays in sync with the
// shipped package without a manual edit.
const require = createRequire(import.meta.url);
const PKG = require("../package.json") as { version: string };

const server = new McpServer({
  name: "geom-scraper",
  version: PKG.version,
});

// S1: URL must be http/https and not a private/loopback address
const urlSchema = z
  .string()
  .url()
  .refine(
    (v) => {
      try {
        validateUrl(v);
        return true;
      } catch {
        return false;
      }
    },
    "URL must use http: or https: and not target a private/loopback address",
  );

// U2: reformatted tool description with newlines
server.tool(
  "scrape_page",
  [
    "幾何構造ベースで反復カードを抽出してJSONで返す。CSSクラス/XPath非依存。",
    "preset values: shopping / generic (default) / raw",
    "  shopping → title/price/image/url",
    "  generic  → image/primaryText/secondaryText/meta/links/url",
    "  raw      → texts[]/images[]/links[] (arrays of all values)",
    "全グループを調べる場合は all_groups:true、または list_card_groups ツールを使う。",
    // U1: SSRF restriction note
    "URL は http: / https: のみ。private/loopback アドレスはブロックされる (GEOM_SCRAPER_ALLOW_PRIVATE=1 で解除)。",
  ].join("\n"),
  {
    // S1: apply SSRF-guarded URL schema
    url: urlSchema.describe(
      "スクレイプ対象のURL (http: / https: のみ。private/loopback はブロック)",
    ),
    preset: z
      .enum(["shopping", "generic", "raw"])
      .optional()
      .describe("出力スキーマ。shopping / generic (既定) / raw。省略時は generic と同じ"),
    group_index: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "どのカードグループを採用するか。既定は 0 (最上位スコア)。範囲外は自動 clamp (groupCount-1)。クランプ時は result.note に記録される",
      ),
    all_groups: z
      .boolean()
      .optional()
      .describe(
        "検出した全グループを配列で返す。既定 false。true 時の戻り値は ScrapeResult[] (配列)",
      ),
    wait_ms: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("スクロール後の追加待ちミリ秒。SPA向けに長めに設定可。最大 30000"),
  },
  // U4: wrap handler in try/catch returning isError response
  async ({ url, preset, group_index, all_groups, wait_ms }) => {
    try {
      const result = await scrape(url, {
        preset,
        groupIndex: group_index,
        allGroups: all_groups === true,
        waitMs: wait_ms,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (e) {
      console.error("[geom-scraper-mcp] scrape_page error:", e);
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Error: ${(e as Error).message}`,
          },
        ],
      };
    }
  },
);

server.tool(
  "list_card_groups",
  [
    "ページに含まれる全カードグループの fingerprint と件数だけ返す。",
    "どの preset / group_index で scrape_page を叩くか調査する用途。",
    // U1: explicit output shape
    "出力: [{index, cardCount, fingerprint}, ...] のみ (items は含まれない)",
    "URL は http: / https: のみ。private/loopback はブロック (GEOM_SCRAPER_ALLOW_PRIVATE=1 で解除)。",
  ].join("\n"),
  {
    // S1: apply SSRF-guarded URL schema
    url: urlSchema.describe(
      "対象のURL (http: / https: のみ。private/loopback はブロック)",
    ),
    wait_ms: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("スクロール後の追加待ちミリ秒。SPA向けに長めに設定可。最大 30000"),
  },
  // U4: wrap handler in try/catch returning isError response
  async ({ url, wait_ms }) => {
    try {
      // U9: pass an options object that satisfies the `allGroups: true`
      // overload, so the return type is inferred as ScrapeResult[] rather
      // than the union — no need for the Array.isArray runtime fallback.
      const groups = await scrape(url, {
        preset: "generic",
        allGroups: true,
        waitMs: wait_ms,
      });
      const summary = groups.map((g, i) => ({
        index: i,
        cardCount: g.cardCount,
        fingerprint: g.fingerprint,
      }));
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(summary, null, 2) },
        ],
      };
    } catch (e) {
      console.error("[geom-scraper-mcp] list_card_groups error:", e);
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Error: ${(e as Error).message}`,
          },
        ],
      };
    }
  },
);

// B12: wrap top-level connect in try/catch
const transport = new StdioServerTransport();
try {
  await server.connect(transport);
  console.error("[geom-scraper-mcp] ready on stdio");
} catch (e) {
  console.error("[geom-scraper-mcp] failed to connect transport:", e);
  process.exit(1);
}
