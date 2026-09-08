/**
 * Playwright の Chromium 起動オプションを組み立てる共有ヘルパー。
 *
 * `npx playwright install` を実行できない環境（オフラインの CI・ブラウザを別途配置済みの
 * コンテナ・サンドボックス等）でもブラウザを起動できるようにするための逃げ道を、
 * E2E（`playwright.config.ts`）とデモ撮影（`scripts/capture-screenshots.mjs`）で共有する。
 *
 * **なぜ 2 か所で共有するのか。** 以前は撮影スクリプトだけがこの逃げ道を持ち、
 * `playwright.config.ts` には無かった。そのため CLAUDE.md §2 が「CI と同じコマンドを
 * ローカルで流す」と定めているのに、`npm run test:e2e` だけはブラウザを取得できない環境で
 * 実行できず（`browserType.launch: Executable doesn't exist at ...` で全件失敗）、
 * 検証を CI 任せにするしかなかった。同じ判定を 2 か所へ書き写すと、環境変数名を変えたときに
 * 片方だけ直し忘れて同じ状態に戻るので、判定はこのファイル 1 つに置く（§6 DRY）。
 */

// ブラウザ本体のパスを上書きする環境変数の名前（この 1 か所だけが正）。
// 名前は姉妹リポジトリ `my-first-ai-app` と同じ `PLAYWRIGHT_CHROMIUM_PATH` にそろえてある
// （撮影専用だった頃の `CAPTURE_CHROMIUM_EXECUTABLE` は、E2E も使うようになった時点で
//  役割を正しく表さなくなったため改名した）。外部からは chromiumLaunchOptions() 経由で
// のみ使うので、定数自体はモジュール内に閉じる
const CHROMIUM_PATH_ENV = "PLAYWRIGHT_CHROMIUM_PATH";

/**
 * Chromium の起動オプションを返す。
 *
 * 環境変数が未設定なら空オブジェクトを返し、Playwright 既定のブラウザ解決に従わせる
 * （＝通常の開発者・CI では今までどおり同梱の Chromium が使われる）。
 *
 * @returns {{ executablePath?: string }} chromium.launch() / launchOptions に渡せるオブジェクト
 */
export function chromiumLaunchOptions() {
  // 環境変数で指定された Chromium の実行ファイルパスを読む
  const executablePath = process.env[CHROMIUM_PATH_ENV];
  // 未設定（または空文字）なら上書きしない＝Playwright 既定の解決に任せる
  if (!executablePath) return {};
  // 指定があればその実行ファイルを使う
  return { executablePath };
}
