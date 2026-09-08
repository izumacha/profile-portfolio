import { defineConfig } from "@playwright/test";
// ブラウザ起動オプションの組み立ては撮影スクリプトと共有する（重複定義を避けるため）
import { chromiumLaunchOptions } from "./scripts/lib/chromium-launch-options.mjs";

export default defineConfig({
  testDir: "e2e",
  retries: process.env.CI ? 2 : 0,
  expect: {
    // Tolerate minor antialiasing/font-rendering differences between the
    // machine that generated the snapshots and the CI runner.
    toHaveScreenshot: { maxDiffPixelRatio: 0.02 },
  },
  use: {
    baseURL: "http://127.0.0.1:4173",
    // ブラウザ本体のパスを環境変数で上書きできるようにする逃げ道（判定の実体は共有ヘルパー側）。
    // これが無いと、ブラウザをダウンロードできない環境では `npm run test:e2e` が
    // 「Executable doesn't exist at ...」で全件落ち、CLAUDE.md §2 の「CI と同じコマンドを
    // ローカルで流す」が実行できない
    launchOptions: chromiumLaunchOptions(),
  },
  webServer: {
    command: "npx --yes http-server . -p 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});

