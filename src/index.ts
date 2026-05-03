import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { scrape } from "./extract.js";

interface CliArgs {
  url: string;
  out: string;
  allGroups: boolean;
  groupIndex?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    url: "",
    out: "output/result.json",
    allGroups: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") args.url = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--all-groups") args.allGroups = true;
    else if (a === "--group") args.groupIndex = Number(argv[++i]);
    else if (!a.startsWith("--") && !args.url) args.url = a;
  }
  if (!args.url) {
    console.error(
      "Usage: tsx src/index.ts <url> [--out path] [--group N] [--all-groups]",
    );
    process.exit(1);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.error(`[geom-scraper] fetching ${args.url} ...`);
  const result = await scrape(args.url, {
    groupIndex: args.groupIndex,
    allGroups: args.allGroups,
  });
  const outPath = resolve(args.out);
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
  }
  console.error(`[geom-scraper] wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
