/**
 * スクロール連動アニメーションの「発火済み」状態を作るための共有ヘルパー。
 *
 * index.html はカード / タイムライン項目を IntersectionObserver で検知してから
 * フェードインさせる（初期状態は opacity:0）。ページを開いただけではビューポート外の
 * 要素が一度も交差判定されないため、fullPage スクリーンショットや下方向へジャンプする
 * 画面キャプチャでは中身が透明のまま写り込んでしまう。
 *
 * 実際の閲覧と同じようにページ最下部まで少しずつスクロールして全要素の交差判定を
 * 発火させてから先頭に戻すことで、この問題を回避する。
 * ビジュアルリグレッション（e2e/visual.spec.ts）とスクリーンショット自動撮影
 * （scripts/capture-screenshots.mjs）の両方で必要になる処理なので、
 * 同じロジックを 2 か所に書き写さずここへ集約する（CLAUDE.md §6 DRY）。
 */

// 交差判定のコールバックが実行されるのを待つ 1 ステップあたりの待機時間（ミリ秒）
const OBSERVER_SETTLE_MS = 60; // 短すぎると opacity:0 のまま撮れてしまうため一呼吸置く

/**
 * ページを最下部まで段階的にスクロールし、スクロール連動アニメーションを全て発火させてから先頭へ戻す。
 *
 * @param {import('@playwright/test').Page} page 対象の Playwright ページ
 * @returns {Promise<void>} スクロール往復とアニメーション発火が完了したら解決する Promise
 */
export async function primeScrollAnimations(page) {
  // ブラウザ側のコンテキストでスクロール処理を実行する（待機時間は引数で渡す）
  await page.evaluate(async (settleMs) => {
    // 1 ステップのスクロール量はビューポートの高さぶんにする（画面 1 枚ずつ送る）
    const step = window.innerHeight;
    // ページ先頭から最下部まで 1 画面ずつスクロールしていく
    for (let y = 0; y <= document.body.scrollHeight; y += step) {
      // ページ側は html { scroll-behavior: smooth } を設定しているため、既定の scrollTo だと
      // アニメーション中に次のスクロール命令で割り込まれ、短い待機時間内に目的位置まで到達できない
      // （IntersectionObserver が発火しないまま次へ進んでしまう）。behavior: "instant" で
      // smooth を明示的に無効化し、命令どおりの位置へ即座に移動する
      window.scrollTo({ top: y, left: 0, behavior: "instant" });
      // 各ステップ後に一呼吸置き、IntersectionObserver のコールバックが実行される時間を与える
      await new Promise((resolve) => setTimeout(resolve, settleMs));
    }
    // 全要素の交差判定が終わったらページ先頭へ戻す（撮影開始位置を揃える）
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, OBSERVER_SETTLE_MS);
}
