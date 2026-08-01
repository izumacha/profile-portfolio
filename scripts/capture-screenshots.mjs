/**
 * README 掲載用のスクリーンショットとデモ GIF を自動撮影するスクリプト（CLAUDE.md §15）。
 *
 * 撮影対象は CLAUDE.md「見せ方（§15 の具体化）」で定めた 4 枚 + デモ GIF 1 本:
 *   1. docs/screenshots/index-hero-dark.png   … メインページのファーストビュー（ダークテーマ）
 *   2. docs/screenshots/index-sections-dark.png … スキル / タイムライン等の主要セクション
 *   3. docs/screenshots/resume-light.png      … 履歴書ページ（ライトテーマ）
 *   4. docs/screenshots/index-mobile-768.png  … 768px モバイル表示
 *   5. docs/screenshots/portfolio-nav.gif     … ナビゲーション遷移 + スクロールアニメーション
 *
 * 実行方法は README / CLAUDE.md §2 を参照（`npm run capture:screenshots`）。
 * ビジュアルリグレッション（e2e/visual.spec.ts）と同じ Playwright + Chromium を再利用する。
 */

// Playwright のブラウザ起動 API（テストランナーではなくスクリプトから直接使う）
import { chromium } from "@playwright/test";
// 外部プロセス（ffmpeg）を起動するための Node 標準モジュール
import { spawn } from "node:child_process";
// 出力先ディレクトリ作成・一時ディレクトリ削除に使う Node 標準モジュール
import { mkdir, mkdtemp, rm } from "node:fs/promises";
// 一時ディレクトリの置き場所（OS の temp 領域）を得るための Node 標準モジュール
import { tmpdir } from "node:os";
// パス結合と、このファイル自身の位置からリポジトリルートを求めるための Node 標準モジュール
import { join, dirname, resolve } from "node:path";
// import.meta.url（file:// URL）を通常のファイルパスへ変換するための Node 標準モジュール
import { fileURLToPath } from "node:url";
// 撮影用のローカル静的サーバー（data/portfolio.json を fetch できるようにするため）
import { startStaticServer } from "./lib/static-server.mjs";
// スクロール連動アニメーションを事前に発火させる共有ヘルパー（e2e と共用）
import { primeScrollAnimations } from "./lib/scroll-priming.mjs";

// このスクリプト自身が置かれているディレクトリ（scripts/）
const scriptDir = dirname(fileURLToPath(import.meta.url));
// リポジトリのルートディレクトリ（scripts/ の 1 つ上）。配信ルート兼出力先の基準にする
const repoRoot = resolve(scriptDir, "..");
// 画像の出力先ディレクトリ（CLAUDE.md §15 で docs/screenshots/ に統一すると定めている）
const outputDir = join(repoRoot, "docs", "screenshots");

// 撮影用ローカルサーバーのポート番号。E2E（4173）と衝突しないよう別番号にする
const CAPTURE_PORT = 4174;

// デスクトップ撮影時のビューポート幅（CLAUDE.md §15 の「幅 1280px 目安」に合わせる）
const DESKTOP_WIDTH = 1280;
// デスクトップ撮影時のビューポート高さ（ファーストビューとして自然な 16:10 に近い比率）
const DESKTOP_HEIGHT = 800;
// モバイル撮影時のビューポート幅（CLAUDE.md のレスポンシブ規約で定めたブレークポイント）
const MOBILE_WIDTH = 768;
// モバイル撮影時のビューポート高さ（縦長の一般的なタブレット/大型スマホ相当）
const MOBILE_HEIGHT = 1024;

// GIF に収めるナビゲーション遷移の対象セクション（README のデモで見せたい順に並べる）
const GIF_SECTIONS = ["about", "skills", "works", "timeline", "contact"];
// 1 セクションあたりに撮るフレーム数（スムーススクロールの途中経過を数コマ残す）
const GIF_FRAMES_PER_SECTION = 6;
// フレーム 1 枚あたりの待機時間（ミリ秒）。GIF の再生速度（= 1000/この値 fps）と対応する
const GIF_FRAME_INTERVAL_MS = 125;
// GIF の出力幅（ピクセル）。10MB 以下に収めるため原寸 1280px から縮小する（§15 / §8）
const GIF_WIDTH = 800;
// GIF の再生フレームレート。撮影間隔（GIF_FRAME_INTERVAL_MS）と揃えて等速再生にする
const GIF_FRAMERATE = 1000 / GIF_FRAME_INTERVAL_MS;

// 使用する Chromium 実行ファイルを差し替えるための環境変数名。
// 通常は `npx playwright install chromium` で入る Playwright 同梱の Chromium が使われるが、
// ブラウザを別途配置済みでダウンロードできない環境（オフラインの CI・コンテナ等）では
// この環境変数に実行ファイルのパスを渡して既存の Chromium を使い回せるようにする
const CHROMIUM_EXECUTABLE_ENV = "CAPTURE_CHROMIUM_EXECUTABLE";

/**
 * 外部コマンドを引数配列で起動し、終了を待つ。
 * ユーザー入力を文字列連結でシェルへ渡さない（CLAUDE.md §9 危険な実行を避ける）。
 *
 * @param {string} command 実行するコマンド名
 * @param {string[]} args コマンドに渡す引数の配列
 * @returns {Promise<void>} 終了コード 0 で解決し、それ以外は例外で失敗する Promise
 */
function run(command, args) {
  // 子プロセスの完了を Promise として扱えるように包む
  return new Promise((resolveRun, rejectRun) => {
    // シェルを介さずに直接プロセスを起動する（標準エラーだけ親へ流して進捗を見せる）
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "inherit"] });
    // 起動自体に失敗した場合（コマンド不在など）は理由を添えて失敗させる
    child.on("error", (err) =>
      rejectRun(new Error(`${command} の起動に失敗しました: ${err.message}`)),
    );
    // プロセス終了時に終了コードを確認し、0 以外はエラーとして扱う（握り潰さない §6）
    child.on("close", (code) =>
      code === 0 ? resolveRun() : rejectRun(new Error(`${command} が終了コード ${code} で失敗しました`)),
    );
  });
}

/**
 * 静止画スクリーンショット 4 枚を撮影する。
 *
 * @param {import('@playwright/test').Browser} browser 起動済みの Chromium
 * @param {string} origin 撮影対象を配信しているローカルサーバーの URL
 * @returns {Promise<void>} 4 枚の書き出しが完了したら解決する Promise
 */
async function captureStills(browser, origin) {
  // デスクトップ幅のページを開く（ダークテーマのメインページ用）
  const desktop = await browser.newPage({
    viewport: { width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT },
  });

  // メインページを開き、ネットワークが落ち着く（portfolio.json の取得完了）まで待つ
  await desktop.goto(`${origin}/index.html`, { waitUntil: "networkidle" });
  // スクロール連動アニメーションを一巡させてから先頭に戻す（透明のまま撮らないため）
  await primeScrollAnimations(desktop);
  // 1 枚目: ファーストビュー（ページ先頭のヒーロー領域）を撮る
  await desktop.screenshot({ path: join(outputDir, "index-hero-dark.png") });

  // 2 枚目の準備: 主要セクション（スキル）の先頭までスクロールする
  await desktop.evaluate(() => {
    // ナビゲーションと同じ移動先である #skills 要素を取得する
    const target = document.querySelector("#skills");
    // 見つかった場合のみ、アニメーションを挟まず即座にその位置へ移動する
    if (target) target.scrollIntoView({ behavior: "instant", block: "start" });
  });
  // 2 枚目: スキル / タイムライン等の主要セクションを撮る
  await desktop.screenshot({ path: join(outputDir, "index-sections-dark.png") });

  // 3 枚目: 履歴書ページ（ライトテーマ・印刷対応）をページ全体で撮る
  await desktop.goto(`${origin}/resume.html`, { waitUntil: "networkidle" });
  // 履歴書は 1 枚の書類として見せたいので fullPage で縦に全部収める
  await desktop.screenshot({ path: join(outputDir, "resume-light.png"), fullPage: true });
  // デスクトップ用ページはここで閉じる（リソースを確実に解放する §8）
  await desktop.close();

  // 4 枚目: 768px 幅のモバイル表示を撮るための別ページを開く
  const mobile = await browser.newPage({
    viewport: { width: MOBILE_WIDTH, height: MOBILE_HEIGHT },
  });
  // モバイル幅でメインページを開く
  await mobile.goto(`${origin}/index.html`, { waitUntil: "networkidle" });
  // モバイル幅でもアニメーションを発火させてから先頭に戻す
  await primeScrollAnimations(mobile);
  // 4 枚目: モバイル幅のファーストビューを撮る
  await mobile.screenshot({ path: join(outputDir, "index-mobile-768.png") });
  // モバイル用ページを閉じる
  await mobile.close();
}

/**
 * ナビゲーション遷移のデモ GIF を撮影する。
 * PNG のコマ画像を一時ディレクトリへ書き出し、ffmpeg で GIF にまとめる。
 *
 * @param {import('@playwright/test').Browser} browser 起動済みの Chromium
 * @param {string} origin 撮影対象を配信しているローカルサーバーの URL
 * @returns {Promise<void>} GIF の書き出しが完了したら解決する Promise
 */
async function captureNavigationGif(browser, origin) {
  // コマ画像を貯めるための一時ディレクトリを作る（リポジトリを汚さない）
  const framesDir = await mkdtemp(join(tmpdir(), "portfolio-gif-"));
  // GIF 用のページを開く（静止画と同じデスクトップ幅で撮る）
  const page = await browser.newPage({
    viewport: { width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT },
  });

  try {
    // メインページを開き、データ取得が終わるまで待つ
    await page.goto(`${origin}/index.html`, { waitUntil: "networkidle" });
    // 遷移先のカードが透明のまま写らないよう、先にアニメーションを一巡させる
    await primeScrollAnimations(page);

    // 書き出したコマ数のカウンタ（ファイル名の連番に使う）
    let frameIndex = 0;

    /**
     * 現在の画面を 1 コマとして書き出し、次のコマまで待つ。
     * @returns {Promise<void>} 1 コマの書き出しと待機が終わったら解決する Promise
     */
    const captureFrame = async () => {
      // 連番 4 桁のファイル名にして ffmpeg が順序どおり読めるようにする
      const name = `frame-${String(frameIndex).padStart(4, "0")}.png`;
      // 現在のビューポートを 1 コマとして書き出す
      await page.screenshot({ path: join(framesDir, name) });
      // 次のコマ用にカウンタを進める
      frameIndex += 1;
      // 実際の再生間隔と同じだけ待ってから次のコマを撮る（等速の動きに見せる）
      await page.waitForTimeout(GIF_FRAME_INTERVAL_MS);
    };

    // 冒頭にファーストビューの静止コマを数枚入れて「どのページか」を分かるようにする
    for (let i = 0; i < GIF_FRAMES_PER_SECTION / 2; i += 1) await captureFrame();

    // 各セクションへナビゲーションリンクで移動しながらコマを撮っていく
    for (const sectionId of GIF_SECTIONS) {
      // ヘッダのナビゲーションにある該当リンクをクリックする（実際の操作を再現する）
      await page.click(`nav a[href="#${sectionId}"]`);
      // スムーススクロールの途中経過を複数コマに分けて記録する
      for (let i = 0; i < GIF_FRAMES_PER_SECTION; i += 1) await captureFrame();
    }

    // 出力する GIF のファイルパス
    const gifPath = join(outputDir, "portfolio-nav.gif");
    // ffmpeg でコマ画像を GIF に変換する。
    // 256 色しか使えない GIF は、既定の固定パレットだとダークテーマのグラデーションが
    // 大きく破綻するため、palettegen で内容に合わせたパレットを作ってから paletteuse で適用する
    await run("ffmpeg", [
      "-y", // 既存ファイルを確認なしで上書きする
      "-framerate", String(GIF_FRAMERATE), // 入力コマ画像の再生速度（撮影間隔と一致させる）
      "-i", join(framesDir, "frame-%04d.png"), // 連番のコマ画像を入力にする
      "-filter_complex", // 縮小 → パレット生成 → パレット適用を 1 つのフィルタグラフで行う
      `[0:v] scale=${GIF_WIDTH}:-1:flags=lanczos,split [scaled][forPalette];` +
        `[forPalette] palettegen=stats_mode=diff [palette];` +
        `[scaled][palette] paletteuse=dither=bayer:bayer_scale=5`,
      "-loop", "0", // 0 は無限ループ再生を意味する（README 上で繰り返し再生させる）
      gifPath, // 出力先の GIF ファイル
    ]);
  } finally {
    // 成功・失敗にかかわらずページを閉じる（§8 リソースを確実に解放する）
    await page.close();
    // コマ画像の一時ディレクトリも必ず片付ける
    await rm(framesDir, { recursive: true, force: true });
  }
}

/**
 * 撮影処理全体のエントリーポイント。
 * @returns {Promise<void>} すべての撮影が完了したら解決する Promise
 */
async function main() {
  // 出力先ディレクトリを（無ければ）作成する
  await mkdir(outputDir, { recursive: true });
  // 撮影対象のサイトをローカル HTTP で配信する
  const server = await startStaticServer(repoRoot, CAPTURE_PORT);
  // 環境変数で実行ファイルが指定されていればそれを使う（未指定なら Playwright 同梱の Chromium）
  const executablePath = process.env[CHROMIUM_EXECUTABLE_ENV];
  // Playwright の Chromium をヘッドレスで起動する
  const browser = await chromium.launch(executablePath ? { executablePath } : {});

  try {
    // 静止画 4 枚を撮る
    await captureStills(browser, server.origin);
    // デモ GIF を 1 本撮る
    await captureNavigationGif(browser, server.origin);
    // どこへ書き出したかを利用者に伝える
    console.log(`撮影が完了しました: ${outputDir}`);
  } finally {
    // 成功・失敗にかかわらずブラウザを閉じる
    await browser.close();
    // 配信サーバーも必ず停止する
    await server.close();
  }
}

// エントリーポイントを実行し、失敗した場合は理由を表示して終了コード 1 で終わる
main().catch((err) => {
  // 失敗理由を標準エラーへ出す（握り潰さない §6）
  console.error(err);
  // CI やシェルから失敗を検知できるよう終了コードを 1 にする
  process.exitCode = 1;
});
