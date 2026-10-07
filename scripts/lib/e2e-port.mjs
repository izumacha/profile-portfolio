/**
 * E2E で使う配信ポートの唯一の定義。
 *
 * 配信側（scripts/serve-e2e.mjs）と Playwright 側（playwright.config.ts の
 * baseURL / webServer.url）が同じ値を見る必要があり、3 か所に数字を書き写すと
 * 割れたときに E2E が起動待ちでタイムアウトする（CLAUDE.md §6 一元管理）。
 *
 * **副作用の無いこのファイルに置く。** 定数を serve-e2e.mjs 側に置いて
 * playwright.config.ts から import すると、あちらはトップレベルでサーバーを
 * 起動するモジュールなので、設定を読み込んだだけでサーバーが立ち上がってしまう。
 */

// 待ち受けポート番号（127.0.0.1 のみで待ち受ける）
export const E2E_PORT = 4173;
