# geom-scraper

幾何構造（要素のbbox・テキスト長・画像有無）だけで反復カードを抽出する汎用スクレイパー。
CSS class / XPath を使わないので、サイトのマークアップが変わっても壊れにくい。
ショッピングだけでなく、ニュース・記事一覧・動画一覧・リポジトリ一覧など**カード状の繰り返しがあれば何でも**対象。

## 構成

```
src/
  capture.ts    Playwright で全要素の幾何情報を取得（stealth有効）
  normalize.ts  viewport 正規化、特徴量を計算
  cluster.ts    同じ親に並ぶ似た構造を「カード」群として検出
  infer.ts      preset別に役割推定 (shopping / generic / raw)
  extract.ts    パイプライン
  index.ts      CLI
output/
  result.json   実行結果
```

## 使い方

```bash
npm install
npx playwright install chromium
npm run scrape -- "https://example.com/search?q=foo" --preset generic
```

オプション:

- `--preset shopping|generic|raw` 出力スキーマ（既定 `generic`）
- `--out path` 出力先（既定 `output/result.json`）
- `--group N` どのカードグループを採用するか（既定 0 = 最上位スコア）
- `--all-groups` 検出した全グループを返す
- `--no-stealth` stealth init scriptを無効化
- `--headed` ブラウザを表示
- `--wait ms` スクロール後の追加待ち
- `--debug` `<name>.png` (スクショ) + `<name>.raw.json` (生nodes) を出力

## プリセット

### `shopping`
EC サイト向け。
```json
{ "title": "...", "price": "¥1,234", "image": "https://...", "url": "https://..." }
```
- `price` は `[¥￥$€£]xx,xxx` または `xx,xxx円` に matchした部分だけを抽出
- 「ポイント / pt / points」は価格扱いしない

### `generic` (既定)
ニュース・記事・動画・リポなど何でも。
```json
{
  "image": "https://...",
  "primaryText": "見出し相当（タイトル/リポ名/動画タイトル等）",
  "secondaryText": "説明・本文・リード相当（あれば）",
  "meta": ["短いテキスト断片の配列（著者/時刻/カウント等）"],
  "links": [{ "text": "...", "href": "https://..." }],
  "url": "カードの主リンク"
}
```

### `raw`
カード内の素材を全部出す。LLM に整形させる前段に。
```json
{ "texts": ["...", "..."], "images": ["..."], "links": [{ "text": "...", "href": "..." }] }
```

## アルゴリズム

1. Playwright でロード → 全要素の bbox / text / hasImage / isLink / childTags / parent を取得
2. viewport で正規化、aspect ratio / area ratio / log(textLength) を計算
3. 同じ親を持つ兄弟群を fingerprint (`tag|childCount|imghave|aspectBucket|textLenBucket|childTagsSig`) で集約
4. カード数 ≥3 の集約を「カードグループ」、`cards × meanArea × imgRatio × textRatio` で score 順
5. 各カードを BFS 降下し、preset別ルールで役割推定

## 実証結果

### shopping preset
| サイト | カード数 | title | price | image | url |
|---|---|---|---|---|---|
| books.toscrape.com | 20/20 | ✓ | £51.77 | ✓ abs | ✓ |
| jp.mercari.com (検索) | 34/34 | ✓ | ¥2,600 | ✓ webp | ✓ |
| shopping.yahoo.co.jp (検索) | 40/40 | ほぼ◎ | 1,100円 | ✓ | ✓ |
| amazon.co.jp (検索) | 55/55 | ✓ | ￥29,800 | ✓ | ✓ (sspaリダイレクト経由) |

### generic preset
| サイト | カード数 | primaryText | meta含有 | url |
|---|---|---|---|---|
| news.ycombinator.com | 30/30 | 記事タイトル ✓ | 順位/ドメイン | ✓ |
| zenn.dev/topics/typescript | 47/47 | 記事タイトル ✓ | 著者/投稿時期/いいね数 | ✓ |
| youtube.com (検索) | 10/10 | 動画/プレイリスト名 ✓ | チャンネル/レッスン数 | ✓ |
| github.com/trending | 11/11 | リポ名 ✓ | 「Star」等のラベル | ✓ |

すべて class名 / XPath 不使用、stealth (navigator.webdriver / WebGL / plugins) で headless 検知も通過。

## トークン節約

LLM に HTML を丸投げするのと比べて **約50〜100倍** 圧縮:

| 入力 | サイズ | 推定トークン |
|---|---|---|
| Amazon検索結果ページの生HTML | ~1.5MB | 約40〜80万 |
| `output/amazon.json` (55カード × 4フィールド) | 約30KB | 約8千 |
| `--preset generic` の主要フィールドのみ | 約10〜15KB | 約3〜4千 |

LLMハイブリッド推奨パターン: **ルール抽出で90%、ノイズが残った数件だけ LLM に投げて補正/分類**。

## 制約

- 動的ロード（無限スクロール 2画面目以降）は未対応
- ログイン必須サイトは未対応
- `iframe` 内は対象外
- カードが複数行 (`<tr>` を2行で1記事 等) に跨る構造は片側しか拾わない (HN例)
- ルールベース推定なので 1〜2件のノイズは残る — 完璧にしたい場合は `--preset raw` で素材出力して LLM に整形させる
