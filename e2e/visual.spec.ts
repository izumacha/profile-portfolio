import { test, expect } from "@playwright/test";
// git の追跡一覧を引くための Node 標準モジュール（撮影対象の網羅を照合するのに使う）
import { execFileSync } from "node:child_process";
// リポジトリ直下を求めるための Node 標準モジュール
import { join } from "node:path";
// スクロール連動アニメーションを事前に発火させる共有ヘルパー
// （スクリーンショット自動撮影 scripts/capture-screenshots.mjs と共用。CLAUDE.md §6 DRY）
import { primeScrollAnimations } from "../scripts/lib/scroll-priming.mjs";


// このスペックが実際に撮影しているページ。下のテストが 1 枚ずつ名指しで撮る対象と対応する。
// （導出にしないのはスナップショット名を固定したいため。代わりに網羅を下のガードで照合する）
const CAPTURED_PAGES: ReadonlyArray<string> = ["/index.html", "/resume.html"];

// このファイルの場所からリポジトリ直下を求める（e2e/ の 1 つ上。csp.spec.ts と同じ書き方）
const REPO_ROOT = join(__dirname, "..");

/**
 * **撮影対象がリポジトリの全ページを覆っているかを照合する。**
 *
 * e2e/csp.spec.ts は「webfont の font-src 違反は自分では観測できず、この視覚回帰が
 * 塞いでいる」と記録している。ところがこのスペックはページを名指ししているだけなので、
 * **ページを 1 枚足した瞬間にその約束が黙って嘘になる**（新しいページは csp.spec.ts の
 * 導出には自動で入って「違反ゼロ」で緑になり、こちらでは撮影されないので、
 * font-src を書き忘れたページが全件緑のまま公開されうる）。
 *
 * 照合には **撮影対象の一覧とは独立な手がかり**として git の追跡一覧を使う
 * （csp.spec.ts の取りこぼしガードが `git ls-files` を「あるべき集合」に使っているのと同じ理由。
 * 同じ手がかりで書くと、一覧が狭まったときにガードも一緒に狭まって無力化される）。
 */
test("撮影対象がリポジトリの全ページを覆っている", () => {
  // git が追跡している HTML ページを列挙する（配信される集合そのもの）
  const output = execFileSync("git", ["ls-files", "--", "*.html", "*.htm"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  // 1 行 1 ファイルなので、空行を落として baseURL からのパスへそろえる
  const tracked = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => `/${line}`)
    .sort();

  // 1 枚も引けないのは git が使えない等で照合が成立していない状態。
  // 「対象ゼロ＝緑」で無力化されないよう fail-closed で落とす
  expect(tracked.length, "git が追跡している HTML ページを 1 枚も列挙できませんでした").toBeGreaterThan(0);

  // 追跡されているのに撮影していないページがあれば、上記の約束が破れている
  const uncaptured = tracked.filter((page) => !CAPTURED_PAGES.includes(page));
  expect(
    uncaptured,
    "撮影していないページがあります。e2e/csp.spec.ts は webfont の font-src 違反を " +
      "この視覚回帰が塞いでいると記録しているので、ページを足したらここにも撮影を足して " +
      "CAPTURED_PAGES を更新してください（撮らないと決めたなら csp.spec.ts の該当コメントも直すこと）",
  ).toEqual([]);

  // 逆に、撮影対象として挙げたのに実在しないページが残っていたら一覧が古い
  const missing = CAPTURED_PAGES.filter((page) => !tracked.includes(page));
  expect(
    missing,
    "CAPTURED_PAGES に、git が追跡していないページが残っています（改名・削除の取り残し）",
  ).toEqual([]);
});

test("index visual snapshot", async ({ page }) => {
  await page.goto("/index.html");
  await page.setViewportSize({ width: 1280, height: 720 });
  // index.html はカード/タイムライン項目を IntersectionObserver で検知してからフェードイン
  // させる（初期状態は opacity:0）ため、fullPage で撮る前にページを一巡させて全要素の
  // 交差判定を発火させる（詳細は共有ヘルパー側のコメントを参照）
  await primeScrollAnimations(page);
  await expect(page).toHaveScreenshot("index.png", { fullPage: true });
});

test("resume visual snapshot", async ({ page }) => {
  await page.goto("/resume.html");
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page).toHaveScreenshot("resume.png", { fullPage: true });
});

