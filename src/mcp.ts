import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { scrape } from "./extract.js";

const server = new McpServer({
  name: "geom-scraper",
  version: "0.1.0",
});

server.tool(
  "scrape_page",
  "幾何構造ベースで反復カードを抽出してJSONで返す。CSSクラス/XPath非依存。" +
    "preset='shopping' は title/price/image/url、'generic' (既定) は image/primaryText/secondaryText/meta/links/url、" +
    "'raw' は texts/images/links 全て。",
  {
    url: z.string().url().describe("スクレイプ対象のURL"),
    preset: z
      .enum(["shopping", "generic", "raw"])
      .optional()
      .describe("出力スキーマ。既定は generic"),
    group_index: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("どのカードグループを採用するか。既定は 0 (最上位スコア)"),
    all_groups: z
      .boolean()
      .optional()
      .describe("検出した全グループを返す。既定 false"),
    wait_ms: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("スクロール後の追加待ち。SPA向けに長めに設定可"),
  },
  async ({ url, preset, group_index, all_groups, wait_ms }) => {
    const result = await scrape(url, {
      preset,
      groupIndex: group_index,
      allGroups: all_groups,
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
  },
);

server.tool(
  "list_card_groups",
  "ページに含まれる全カードグループの fingerprint と件数だけ返す。" +
    "どの preset / group_index で叩くか調査する用途。",
  {
    url: z.string().url().describe("対象のURL"),
    wait_ms: z.number().int().nonnegative().optional(),
  },
  async ({ url, wait_ms }) => {
    const result = await scrape(url, {
      preset: "generic",
      allGroups: true,
      waitMs: wait_ms,
    });
    const arr = Array.isArray(result) ? result : [result];
    const summary = arr.map((g, i) => ({
      index: i,
      cardCount: g.cardCount,
      fingerprint: g.fingerprint,
    }));
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(summary, null, 2) },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[geom-scraper-mcp] ready on stdio");
