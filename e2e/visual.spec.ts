import { test, expect } from "@playwright/test";

test("index visual snapshot", async ({ page }) => {
  await page.goto("/index.html");
  await page.setViewportSize({ width: 1280, height: 720 });
  // index.html はカード/タイムライン項目を IntersectionObserver で検知してから
  // フェードインさせる（初期状態は opacity:0）。fullPage スクリーンショットは実際に
  // スクロールせず一括でページ全体を撮るため、ビューポート外の要素は一度も交差判定
  // されず opacity:0 のまま写り込んでしまう。実際の閲覧と同じくページ最下部まで
  // 少しずつスクロールして全要素の交差判定を発火させてから先頭に戻す。
  // ページ側は html { scroll-behavior: smooth } を設定しているため、既定の
  // scrollTo だとアニメーション中に次のスクロール命令で割り込まれ、短い待機時間内に
  // 目的位置まで到達できない（IntersectionObserver が発火しないまま次に進んでしまう）。
  // behavior: "instant" で smooth を明示的に無効化し、命令どおりの位置へ即座に移動する。
  await page.evaluate(async () => {
    const step = window.innerHeight;
    for (let y = 0; y <= document.body.scrollHeight; y += step) {
      window.scrollTo({ top: y, left: 0, behavior: "instant" });
      // 各ステップ後に一呼吸置き、IntersectionObserver のコールバックが
      // 実行される時間を与える
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  });
  await expect(page).toHaveScreenshot("index.png", { fullPage: true });
});

test("resume visual snapshot", async ({ page }) => {
  await page.goto("/resume.html");
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page).toHaveScreenshot("resume.png", { fullPage: true });
});

