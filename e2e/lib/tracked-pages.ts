/**
 * git が追跡している HTML ページの一覧を返す共有ヘルパー。
 *
 * **配信される集合そのもの**（GitHub Pages が配るのは追跡されているファイル）なので、
 * 「検査対象の導出が狭まっていないか」を照合する独立した手がかりとして使える。
 *
 * ここへ集約する理由: 以前この関数は e2e/csp.spec.ts の中だけにあり、
 * e2e/visual.spec.ts が**写しを持った**。しかも写した側は `-z` を落としていたため、
 * 非 ASCII 名のページ（この repo は日本語なので現実的）で挙動が割れた ——
 * `core.quotePath` の既定は true なので、`-z` 無しの `git ls-files` は
 * `事例.html` を `"\344\272\213\344\276\213.html"` と八進エスケープして引用符で包む（実測）。
 * 片方だけが直る典型で、CLAUDE.md が繰り返し戒めている形そのもの。
 */

// git を shell 無しで起動するための Node 標準モジュール（引数は配列で渡す＝注入の余地なし）
import { execFileSync } from "node:child_process";
// リポジトリ直下を求めるための Node 標準モジュール
import { join } from "node:path";

// このファイルは e2e/lib/ 配下にあるので、2 つ上がリポジトリ直下になる
export const REPO_ROOT = join(__dirname, "..", "..");

/**
 * git が追跡している `.html` / `.htm` を baseURL 起点のパスで返す。
 *
 * @returns baseURL 起点のページパス（先頭 "/" 付き）。名前順は git の出力順に従う
 */
export function trackedPages(): string[] {
  // 追跡中の .html / .htm を git に列挙させる
  // （-z で NUL 区切りにする。改行を含む名前に耐え、quotePath による
  //   八進エスケープ＋引用符も無効になるので、非 ASCII 名がそのまま返る）
  const out = execFileSync("git", ["ls-files", "-z", "--", "*.html", "*.htm"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  // NUL 区切りを分解し、空要素を落として baseURL 起点の書式へそろえる
  return out
    .split("\0")
    .filter(Boolean)
    .map((p) => `/${p}`);
}
