/**
 * E2E (Playwright) 用の静的サーバー起動エントリ。
 *
 * playwright.config.ts の `webServer.command` から呼ばれ、リポジトリ直下をそのまま配信する。
 *
 * **外部パッケージを使わない。** 以前ここは `npx --yes http-server . -p 4173` だったが、
 * `http-server` は package.json にも package-lock.json にも 1 度も現れない未宣言の依存で、
 * `npx --yes` は実行のたびにレジストリの最新版を取りに行っていた。つまり
 * **この repo に何のコミットも無いまま、E2E が実行するコードの中身が変わる**。
 * しかもこれが走る `visual-regression` ジョブは `permissions: contents: write` を持ち、
 * checkout が push 用の資格情報を `.git/config` に残したまま最後に `git push` するので、
 * 上流が乗っ取られた版を配れば、そのコードはリポジトリへ書き込める文脈で動く。
 * CI の html-validate ステップは**同じ理由**で `npx --yes` をやめてピン留めへ移しており
 * (`.github/workflows/ci.yml` のコメントが正本)、ここだけがその移行から取り残されていた。
 *
 * 依存を増やさずに直せるのは、撮影スクリプトが既に使っている標準ライブラリだけの
 * 静的サーバーがあるため (CLAUDE.md §9 サプライチェーン最小化)。同じ実装を共有すれば
 * 「撮影では動くのに E2E では配信の挙動が違う」というずれも同時に消える。
 */

// リポジトリ内の静的サーバー実装 (Node 標準ライブラリのみで組み立てられている)
import { startStaticServer } from "./lib/static-server.mjs";
// 配信ポートの唯一の定義（playwright.config.ts も同じものを読む）
import { E2E_PORT } from "./lib/e2e-port.mjs";
// このファイルの場所からリポジトリ直下を求めるための Node 標準モジュール
import { dirname, resolve } from "node:path";
// import.meta.url (file:// URL) を OS のパスへ変換する Node 標準モジュール
import { fileURLToPath } from "node:url";

// 待ち受けポートは副作用の無い共有モジュールから読む（数字を書き写さない）

// このファイルは scripts/ 配下にあるので、1 つ上がリポジトリ直下になる
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// リポジトリ直下を配信するサーバーを起動する (Playwright が url の応答を待っている)
const server = await startStaticServer(repoRoot, E2E_PORT);

// 起動したことを標準出力に残す (CI のログで「配信が始まった」ことを確認できるようにする)
console.log(`E2E static server listening on ${server.origin}`);

// **シグナルハンドラは置かない。** Playwright は webServer.gracefulShutdown を
// 設定していない限り後始末で `process.kill(-pid, "SIGKILL")` を送る（実測: 通常終了後
// ハンドラのログは 1 行も出ず、gracefulShutdown を足すと初めて出る）。SIGKILL は
// 捕捉できないので、ハンドラを書いても動かないコードになるうえ（CLAUDE.md §6
// デッドコードを残さない）、手で起動したときは Ctrl-C が `server.close()` の完了待ちに
// 化けて止まらなくなる。ポートはプロセス終了時に OS が解放するので、何もしないのが正しい。
