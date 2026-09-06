// CSP が実際に何もブロックしないことを、**本物のブラウザに判定させる**回帰テスト。
//
// なぜこれが要るのか (issue #15 の CSP を壊さないため):
// index.html は GitHub Pages が HTTP ヘッダを付けられないため CSP を <meta> で配信し、
// script-src は 'unsafe-inline' を使わず **インライン script 本文の base64(SHA-256(...))**
// を許可する形になっている。そのため script を 1 文字でも編集するとハッシュが合わなくなり、
// ブラウザがその script の実行を拒否する。壊れ方が見つけにくい:
//   - HTML の構文としては正しいので html-validate は緑のまま通る
//   - サーバーもエラーを返さない (拒否するのはブラウザで、DevTools のコンソールにしか出ない)
//   - 画面は「JS が一切動かないただの静的ページ」になるだけで、レイアウトは崩れない
// 実際にこのテストを足す直前、インライン script へ console.error を 1 行足しただけで
// Live self-proof のバッジが全滅した。
//
// **なぜ静的解析ではなくブラウザで見るのか。**
// 最初は HTML と CSP を自前で解釈して sha256 を突き合わせるスクリプトを書いたが、
// レビューのたびに「その実装が CSP / HTML の文法を取りこぼす」経路が出続けた
// (コメント内の <script>、属性値の中の `>`、script-src-elem による上書き、meta が複数、
//  大文字の `Script-Src-Elem` / `'None'` / `'SHA256-'`、`&#39;` での実体参照、
//  JS の文字列リテラルの中の <meta>、`.htm` 拡張子、'unsafe-inline' との相互作用 …)。
// これは実装の粗さではなく**高度 (altitude) の誤り**で、ブラウザの CSP 実装を
// 正規表現で再実装しようとする限り終わらない (460 行まで育ち、塞ぐたびに穴が出た)。
// ここでは判定そのものをブラウザに任せる: 違反が 1 件でもあれば
// `securitypolicyviolation` イベントが飛ぶので、それを数えるだけでよい。
// 文法の解釈が要らないので、上に挙げた経路はすべて自動的に覆われる。
// **同じ理由で、この検査を静的解析へ戻さないこと。**
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
// スクロール連動の遅延読み込み (loading="lazy" の画像など) も交差判定させてから違反を数えるため、
// ビジュアルリグレッションと同じ共有ヘルパーを使う (CLAUDE.md §6 DRY)
import { primeScrollAnimations } from "../scripts/lib/scroll-priming.mjs";

// このファイル (e2e/) の 1 つ上＝リポジトリのルート。
// Playwright は spec を CJS へ変換して読み込むため import.meta は使えず、__dirname を使う
const REPO_ROOT = join(__dirname, "..");

// 検査対象のページを **リポジトリルートの *.html から導出する**。
// 一覧を手で書き並べない理由は、CI の html-validate をグロブ (`**/*.html`) に変えたのと同じ:
// 写しを持つと、ページを足した人が追加を忘れた瞬間、そのページだけ**黙って**検査対象から
// 外れる。CSP 違反はブラウザのコンソールにしか出ないので、この網から漏れたページは
// 「JS が丸ごと死んでいるのに CI は緑」のまま公開されうる。
// 走査をルート直下に限るのは、配信されるページがここにしか無く、
// 掘ると node_modules など配信されない HTML を拾ってしまうため
// (html-validate 側の `**/*.html` は .htmlvalidateignore で同じものを外している)。
const PAGES: ReadonlyArray<string> = readdirSync(REPO_ROOT)
  // 拡張子が .html のものだけを対象にする
  .filter((name) => name.toLowerCase().endsWith(".html"))
  // 実行順を安定させる
  .sort()
  // baseURL からの絶対パスに直す
  .map((name) => `/${name}`);

// 違反 1 件分の記録 (どのディレクティブが何をブロックしたかを失敗メッセージに出すため)
interface CspViolation {
  // 破られたディレクティブ (例: "script-src")
  directive: string;
  // ブロックされた対象 (例: "inline" や外部 URL)
  blockedURI: string;
}

// ページを開き、その間に起きた CSP 違反をすべて集めて返す。
//
// `securitypolicyviolation` は document に飛ぶイベントで、インライン script の拒否も
// 外部リソースの拒否も同じ形で観測できる。**ページを開く前に**リスナを仕込む必要があるため
// addInitScript を使う (goto のあとに評価すると、その時点までの違反を取り逃す)。
async function collectCspViolations(page: Page, path: string): Promise<CspViolation[]> {
  // ページ内に違反を溜める配列を用意し、document へリスナを付ける。
  // このコードはドキュメント生成の最初期に評価されるので、CSP に拒否される前に間に合う
  await page.addInitScript(() => {
    // 収集先をグローバルに 1 つ用意する (ページ側のコードとは名前が衝突しない綴りにする)
    (window as unknown as { __cspViolations: CspViolation[] }).__cspViolations = [];
    // 違反が起きるたびにディレクティブとブロック対象を記録する
    document.addEventListener("securitypolicyviolation", (e) => {
      (window as unknown as { __cspViolations: CspViolation[] }).__cspViolations.push({
        directive: e.effectiveDirective || e.violatedDirective,
        blockedURI: e.blockedURI,
      });
    });
  });

  // 対象ページを開く。networkidle まで待って、初期読み込みの違反を拾えるようにする
  await page.goto(path, { waitUntil: "networkidle" });

  // 初期読み込みだけでは足りない。ビューポート外の遅延読み込み (loading="lazy" の画像など) は
  // 交差するまで要求が飛ばず、ブロックされても違反イベントが発生しない。
  // ページを一巡させてから数えることで、フォールド下のリソースも判定対象に入れる
  await primeScrollAnimations(page);
  // スクロールで発生した要求が落ち着くのを待つ (遅れて飛ぶ違反を取り逃さないため)
  await page.waitForLoadState("networkidle");

  // ページ側に溜まった違反を取り出して返す
  return page.evaluate(
    () => (window as unknown as { __cspViolations: CspViolation[] }).__cspViolations,
  );
}

test.describe("Content-Security-Policy", () => {
  // 対象ページを 1 枚ずつ検証する
  for (const path of PAGES) {
    test(`${path} は CSP 違反を 1 件も起こさない`, async ({ page }) => {
      // ページを開いて違反を集める
      const violations = await collectCspViolations(page, path);
      // 失敗時に「何がブロックされたか」がそのまま読めるメッセージを組み立てる
      const detail = violations
        .map((v) => `${v.directive} が ${v.blockedURI} をブロック`)
        .join(" / ");
      // 違反が 1 件でもあれば落とす。
      // script まわりの違反は「CSP の sha256 がインライン script と食い違っている」ことが
      // 圧倒的に多いので、直し方を失敗メッセージに添えておく
      expect(
        violations,
        `${path} で CSP 違反が発生した: ${detail}\n` +
          "インライン script を編集した場合は、index.html の CSP meta 内 script-src の\n" +
          "sha256 を新しい本文のハッシュへ更新してください " +
          "(DevTools のコンソールに必要な値が出ます)。",
      ).toEqual([]);
    });
  }

  // 「script が実際に実行されたか」を直接見る網は、あえてここに置かない。
  // sections.spec.ts の「portfolio.json 由来の CI バッジが主力カードに描画される」が
  // 既に同じことを**より強く**確かめている (バッジの有無だけでなく 3 枚すべての
  // ラベル内容まで検証する)。同じ確認をここへ写すと、より弱い重複が 1 つ増えるだけで、
  // バッジのマークアップを変えたときに直す場所が 2 か所になる (§6 DRY)。
});
