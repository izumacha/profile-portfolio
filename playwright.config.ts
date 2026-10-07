import { defineConfig } from "@playwright/test";
// ブラウザ起動オプションの組み立ては撮影スクリプトと共有する（重複定義を避けるため）
import { chromiumLaunchOptions } from "./scripts/lib/chromium-launch-options.mjs";
// 待ち受けポートは配信側と同じ定数を読む（数字を書き写さない。CLAUDE.md §6 一元管理）
import { E2E_PORT } from "./scripts/lib/e2e-port.mjs";

export default defineConfig({
  testDir: "e2e",
  retries: process.env.CI ? 2 : 0,
  expect: {
    // Tolerate minor antialiasing/font-rendering differences between the
    // machine that generated the snapshots and the CI runner.
    toHaveScreenshot: { maxDiffPixelRatio: 0.02 },
  },
  use: {
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    // ブラウザ本体のパスを環境変数で上書きできるようにする逃げ道（判定の実体は共有ヘルパー側）。
    // これが無いと、ブラウザをダウンロードできない環境では `npm run test:e2e` が
    // 「Executable doesn't exist at ...」で全件落ち、CLAUDE.md §2 の「CI と同じコマンドを
    // ローカルで流す」が実行できない
    launchOptions: chromiumLaunchOptions(),
  },
  webServer: {
    // 配信はリポジトリ内の標準ライブラリだけのサーバーで行う。
    // `npx --yes http-server` は未宣言・未ピンの依存を毎回レジストリから取ってきて実行する形で、
    // この repo にコミットが無いまま E2E の実行内容が変わる（理由の正本は scripts/serve-e2e.mjs）
    command: "node scripts/serve-e2e.mjs",
    url: `http://127.0.0.1:${E2E_PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});

