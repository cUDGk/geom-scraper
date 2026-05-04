// MCPプロトコル経由で src/mcp.ts を叩いて動作確認するスクリプト
// 想定動作: tools 2件 (scrape_page / list_card_groups)、scrape_pageでHN取得成功
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverScript = join(here, "..", "src", "mcp.ts");

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath, // node
    args: [
      // tsx を node 経由で起動
      join(here, "..", "node_modules", "tsx", "dist", "cli.mjs"),
      serverScript,
    ],
  });
  const client = new Client(
    { name: "verify-mcp", version: "0.0.1" },
    { capabilities: {} },
  );
  await client.connect(transport);
  console.log("[verify] connected");

  const tools = await client.listTools();
  console.log("[verify] tools:");
  for (const t of tools.tools) console.log(`  - ${t.name}: ${t.description?.slice(0, 80)}`);
  if (tools.tools.length !== 2) throw new Error(`expected 2 tools, got ${tools.tools.length}`);

  console.log("[verify] calling scrape_page on HN ...");
  const res = await client.callTool({
    name: "scrape_page",
    arguments: {
      url: "https://news.ycombinator.com/",
      preset: "generic",
      wait_ms: 1500,
    },
  });
  const content = res.content as Array<{ type: string; text?: string }>;
  const txt = content[0]?.text ?? "";
  const parsed = JSON.parse(txt);
  console.log(
    `[verify] scrape_page OK: cardCount=${parsed.cardCount}, fp=${parsed.fingerprint}`,
  );
  if (!parsed.cardCount || parsed.cardCount < 10) {
    throw new Error(`unexpected cardCount: ${parsed.cardCount}`);
  }
  console.log(`[verify] first item: ${JSON.stringify(parsed.items[0]).slice(0, 120)}`);

  console.log("[verify] calling list_card_groups on HN ...");
  const res2 = await client.callTool({
    name: "list_card_groups",
    arguments: { url: "https://news.ycombinator.com/", wait_ms: 1500 },
  });
  const c2 = res2.content as Array<{ type: string; text?: string }>;
  const groups = JSON.parse(c2[0]?.text ?? "[]");
  console.log(`[verify] list_card_groups OK: ${groups.length} groups`);
  console.log(JSON.stringify(groups, null, 2));

  await client.close();
  console.log("[verify] all checks passed");
}

main().catch((e) => {
  console.error("[verify] FAILED:", e);
  process.exit(1);
});
