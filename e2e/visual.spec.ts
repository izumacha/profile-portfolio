import { test, expect } from "@playwright/test";
// スクロール連動アニメーションを事前に発火させる共有ヘルパー
// （スクリーンショット自動撮影 scripts/capture-screenshots.mjs と共用。CLAUDE.md §6 DRY）
import { primeScrollAnimations } from "../scripts/lib/scroll-priming.mjs";
// 追跡中ページの列挙（csp.spec.ts と共有。写しを持たない）
import { trackedPages } from "./lib/tracked-pages";

/**
 * 撮影対象は **git が追跡しているページから導出する**。手で並べない。
 *
 * e2e/csp.spec.ts は「webfont の font-src 違反は自分では観測できず、その穴は
 * この視覚回帰が塞いでいる」と記録している。その約束が成り立つのは、ここが
 * **全ページ**を撮っているときだけ。
 *
 * 以前ここは撮影対象を手書きの配列で持ち、「一覧が全ページを覆っているか」を
 * 別のテストで照合していた。それでは**そのテストの失敗文言に従うだけで穴が開く**:
 * ページを足す → ガードが赤くなる → 案内どおり配列へ 1 行足す → 緑。
 * しかしスクリーンショットは 1 枚も増えていないので font-src の穴は開いたまま、
 * しかも csp.spec.ts のコメントは「覆っている」と言い続ける。
 * 「登録するだけで黙らせられる口」そのものだった（CLAUDE.md が繰り返し戒めている形）。
 *
 * 導出にすれば、ページを足した時点で撮影が 1 枚増える。覆っていることが
 * 約束ではなく構造になるので、照合用のガードも要らなくなる。
 *
 * スナップショット名はページ名から決まる（/index.html → index.png）ので、
 * 既存のベースライン（index-linux.png / resume-linux.png）はそのまま使える。
 */
const PAGES = trackedPages();

// 1 ページも導出できないのは git が使えない等で撮影が丸ごと消えた状態。
// 「対象ゼロ＝緑」で無力化されないよう、その場合は必ず落ちるテストを 1 本置く
test("撮影対象のページを導出できている", () => {
  // 追跡中の HTML が 1 枚も引けないなら、この spec は何も守っていない
  expect(PAGES.length, "git が追跡している HTML ページを 1 枚も列挙できませんでした").toBeGreaterThan(0);
});

// 導出した全ページを 1 枚ずつ撮って比較する
for (const pagePath of PAGES) {
  // /index.html → index。スナップショット名に使う（既存ベースラインと同じ綴り）
  const name = pagePath.replace(/^\//, "").replace(/\.html?$/i, "");

  test(`${name} visual snapshot`, async ({ page }) => {
    // 対象ページを開く
    await page.goto(pagePath);
    // 比較条件をそろえるためビューポートを固定する
    await page.setViewportSize({ width: 1280, height: 720 });
    // index.html はカード/タイムライン項目を IntersectionObserver で検知してから
    // フェードインさせる（初期状態は opacity:0）ため、fullPage で撮る前にページを
    // 一巡させて全要素の交差判定を発火させる（詳細は共有ヘルパー側のコメントを参照）。
    // 交差判定を持たないページでは最下部まで往復して先頭へ戻るだけで、見た目は変わらない
    await primeScrollAnimations(page);
    // ページ全体を撮ってベースラインと比較する
    await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: true });
  });
}
