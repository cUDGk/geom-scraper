# geom-scraper

幾何構造（要素のbbox・テキスト長・画像有無）だけで商品一覧を抽出するスクレイパー。
CSS class / XPath を使わないので、サイトのマークアップが変わっても壊れにくい。

## 構成

```
src/
  capture.ts    Playwright で全要素の幾何情報を取得
  normalize.ts  viewport で正規化、特徴量を計算
  cluster.ts    同じ親に並ぶ似た構造を「カード」群として検出
  infer.ts      カード内から image / title / price / url を推定
  extract.ts    パイプライン
  index.ts      CLI
output/
  result.json   実行結果
```

## 使い方

```bash
npm install
npx playwright install chromium
npm run scrape -- "https://example.com/search?q=foo"
```

オプション:

- `--out path` 出力先（既定 `output/result.json`）
- `--group N` どのカードグループを採用するか（既定 0 = 一番大きいグループ）
- `--all-groups` 検出した全グループを返す（デバッグ向け）

## アルゴリズム

1. Playwright でロード → 全要素の bbox / text / hasImage / isLink / childTags / parent を取得
2. viewport で正規化、aspect ratio / area ratio / log(textLength) を計算
3. 同じ親を持つ兄弟群を fingerprint (`tag|childCount|imghave|aspectBucket|textLenBucket|childTagsSig`) で集約
4. カード数 ≥3 の集約を「カードグループ」、面積×数でスコア順
5. 各カード内をBFSで降下し:
   - 画像: `hasImage && imgSrc` で最大面積
   - タイトル: リンク優先 + 上半分 + 適度な文字長 + 見出しタグ
   - 価格: `¥/$/€/£/円` または数字密度高い短文
   - URL: カード自身がリンクならそれ、なければ最大面積リンク

## MVP 制約

- 動的ロード（無限スクロール途中など）は最初の1ビュー＋簡易スクロールのみ
- ログイン必須サイトは未対応
- `iframe` 内は対象外
