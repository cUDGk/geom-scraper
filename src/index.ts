import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { scrape } from "./extract.js";

interface CliArgs {
  url: string;
  out: string;
  allGroups: boolean;
  groupIndex?: number;
  stealth: boolean;
  headless: boolean;
  waitMs?: number;
  debug: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    url: "",
    out: "output/result.json",
    allGroups: false,
    stealth: true,
    headless: true,
    debug: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") args.url = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--all-groups") args.allGroups = true;
    else if (a === "--group") args.groupIndex = Number(argv[++i]);
    else if (a === "--no-stealth") args.stealth = false;
    else if (a === "--headed") args.headless = false;
    else if (a === "--wait") args.waitMs = Number(argv[++i]);
    else if (a === "--debug") args.debug = true;
    else if (!a.startsWith("--") && !args.url) args.url = a;
  }
  if (!args.url) {
    console.error(
      "Usage: tsx src/index.ts <url> [--out path] [--group N] [--all-groups] [--no-stealth] [--headed] [--wait ms] [--debug]",
    );
    process.exit(1);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outPath = resolve(args.out);
  const stem = outPath.replace(/\.json$/i, "");
  console.error(`[geom-scraper] fetching ${args.url} ...`);
  const result = await scrape(args.url, {
    groupIndex: args.groupIndex,
    allGroups: args.allGroups,
    stealth: args.stealth,
    headless: args.headless,
    waitMs: args.waitMs,
    screenshotPath: args.debug ? `${stem}.png` : undefined,
    rawNodesPath: args.debug ? `${stem}.raw.json` : undefined,
  });
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(result, null, 2), "utf8");

  if (Array.isArray(result)) {
    console.error(`[geom-scraper] groups=${result.length}`);
    result.forEach((g, i) =>
      console.error(`  [${i}] cards=${g.cardCount} fp=${g.fingerprint}`),
    );
  } else {
    console.error(
      `[geom-scraper] groups=${result.groupCount} cards=${result.cardCount}`,
    );
    if (result.groupSummaries.length > 1) {
      result.groupSummaries.slice(0, 6).forEach((g, i) => {
        console.error(`  [${i}] cards=${g.cardCount} fp=${g.fingerprint}`);
      });
    }
  }
  console.error(`[geom-scraper] wrote ${outPath}`);
  if (args.debug) {
    console.error(`[geom-scraper] debug: ${stem}.png, ${stem}.raw.json`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
