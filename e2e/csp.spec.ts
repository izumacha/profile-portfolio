// CSP が「壊れていない」ことを、**本物のブラウザに判定させる**回帰テスト。
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
// 判定そのものはブラウザに任せる。**同じ理由で、この検査を静的解析へ戻さないこと。**
//
// **ただし「違反ゼロ」だけでは足りない。** 違反を数えるだけの検査は、
// CSP を消しても 'unsafe-inline' を足しても緑になる ——しかもそれは
// 「ハッシュ不一致で赤くなったテストを最短で緑にする」手口そのもの。
// そこで下の 2 本立てにしている:
//   1. 違反ゼロ (ブラウザが実際に何もブロックしないこと)
//   2. 方式が保たれていること (CSP が存在し、script 系に 'unsafe-inline' /
//      'unsafe-eval' が無く、インライン script を持つページには sha256 がある)
// 2 の判定は **DOM から取り出した meta の中身**に対する数本の素朴な検査で、
// HTML の解析はブラウザ任せのまま。文法の細部を取りこぼしても
// **誤って赤くなるだけ**（＝すぐ気づく）で、緑のまま見逃す側には倒れない。
// 自前パーサが危険だったのは、取りこぼしが**誤った緑**になったからである。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";

// このファイル (e2e/) の 1 つ上＝リポジトリのルート。
// Playwright は spec を CJS へ変換して読み込むため import.meta は使えず、__dirname を使う
const REPO_ROOT = join(__dirname, "..");

// 走査しないディレクトリは .htmlvalidateignore を唯一の源として読む。
// CI の html-validate (`**/*.html`) と同じ範囲を見るためで、ここに写しを持つと
// 「構文検査はされるのに CSP は検査されない」ページが黙って生まれる
const IGNORED_DIRS = readFileSync(join(REPO_ROOT, ".htmlvalidateignore"), "utf8")
  .split("\n")
  // コメント行と空行を落とす
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"))
  // "node_modules/" のような書き方から末尾の / を外してディレクトリ名にする
  .map((line) => line.replace(/\/$/, ""));

/**
 * 検査対象のページを **リポジトリの *.html から再帰で導出する**。
 *
 * 一覧を手で書き並べない理由は、CI の html-validate をグロブ (`**\/*.html`) に
 * 変えたのと同じ: 写しを持つと、ページを足した人が追加を忘れた瞬間、
 * そのページだけ**黙って**検査対象から外れる。CSP 違反はブラウザのコンソールにしか
 * 出ないので、この網から漏れたページは「JS が丸ごと死んでいるのに CI は緑」のまま公開されうる。
 *
 * 再帰にするのは html-validate の `**\/*.html` と範囲を合わせるため
 * （片方だけ 1 階層だと、サブディレクトリのページが構文検査だけ受けて CSP は素通りになる）。
 */
function findPages(dir: string, prefix = ""): string[] {
  // 見つかったページを溜める配列
  const found: string[] = [];
  // ディレクトリの中身を種類付きで読み、名前順に安定させる
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    // baseURL からのパスを組み立てる
    const relative = `${prefix}/${entry.name}`;
    // ディレクトリなら、除外対象でない限り 1 つ下も見る
    if (entry.isDirectory()) {
      // 配信されないディレクトリと、隠しディレクトリ (.git 等) は丸ごと飛ばす
      if (IGNORED_DIRS.includes(entry.name) || entry.name.startsWith(".")) continue;
      // 下の階層で見つかったページを足す
      found.push(...findPages(join(dir, entry.name), relative));
      // このエントリの処理は終わり
      continue;
    }
    // **通常のファイルであること**まで確かめる。`zzz.html` という名前のディレクトリが
    // あると、それを開いた 404 応答には CSP が無いので「違反ゼロ」で緑になってしまう
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".html")) found.push(relative);
  }
  // 見つかったページのパスを返す
  return found;
}

// 検査対象のページ一覧
const PAGES: ReadonlyArray<string> = findPages(REPO_ROOT);

// 違反 1 件分の記録 (どのディレクティブが何をブロックしたかを失敗メッセージに出すため)
interface CspViolation {
  // 破られたディレクティブ (例: "script-src")
  directive: string;
  // ブロックされた対象 (例: "inline" や外部 URL)
  blockedURI: string;
}

// 1 ページを開いて集めた観測結果
interface PageObservation {
  // 発生した CSP 違反
  violations: CspViolation[];
  // CSP meta の content 属性 (DOM から取り出したもの。無ければ null)
  policy: string | null;
  // ブラウザが「インラインの JavaScript」として扱う script 要素の数
  inlineScriptCount: number;
}

/**
 * ページを開き、CSP 違反・実際のポリシー・インライン script の数をまとめて観測する。
 *
 * `securitypolicyviolation` は document に飛ぶイベントで、インライン script の拒否も
 * 外部リソースの拒否も同じ形で観測できる。**ページを開く前に**リスナを仕込む必要があるため
 * addInitScript を使う (goto のあとに評価すると、その時点までの違反を取り逃す)。
 */
async function observePage(page: Page, path: string): Promise<PageObservation> {
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

  // 対象ページを開く。networkidle まで待って、読み込み中に起きた違反を拾えるようにする
  const response = await page.goto(path, { waitUntil: "networkidle" });
  // 200 以外はページが存在しない (404 の本文には CSP が無いので「違反ゼロ」で緑になってしまう)
  expect(response?.status(), `${path} が ${response?.status()} を返した`).toBe(200);

  // ページの状態を 1 回の評価でまとめて取り出す
  return page.evaluate(() => ({
    // 溜まった違反
    violations: (window as unknown as { __cspViolations: CspViolation[] }).__cspViolations,
    // CSP meta の中身。**HTML の解析はブラウザが済ませている**ので、
    // コメント内の meta や属性の並び・実体参照といった細部を自前で扱う必要がない
    policy:
      document
        .querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy" i]')
        ?.getAttribute("content") ?? null,
    // ブラウザが JavaScript として扱うインライン script の数。
    // src 無し・type 無し（＝既定の JavaScript）だけを数える。
    // このリポジトリの実行対象インライン script はこの形だけで、
    // 構造化データ (application/ld+json) は type を持つので数に入らない
    inlineScriptCount: document.querySelectorAll("script:not([src]):not([type])").length,
  }));
}

test.describe("Content-Security-Policy", () => {
  test("検査対象のページが 1 枚以上見つかっている", () => {
    // 導出が壊れて 0 件になると、下のループが 1 つもテストを作らず
    // 「違反ゼロ＝緑」に見えてしまう。導出そのものを fail-closed にする
    // (CI の html-validate も対象 0 件なら exit 1 で落ちる。挙動をそろえる)
    expect(PAGES.length, "リポジトリから HTML ページを 1 枚も導出できなかった").toBeGreaterThan(0);
  });

  // 対象ページを 1 枚ずつ検証する
  for (const path of PAGES) {
    test(`${path} は CSP 違反を 1 件も起こさない`, async ({ page }) => {
      // ページを開いて観測する
      const { violations } = await observePage(page, path);
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

    test(`${path} は CSP の方式（ハッシュ許可）を保っている`, async ({ page }) => {
      // ページを開いて観測する
      const { policy, inlineScriptCount } = await observePage(page, path);

      // CSP そのものが消えていないこと。
      // 「違反ゼロ」だけを見ていると、meta を消せば違反も消えて緑になる
      expect(policy, `${path} に Content-Security-Policy の meta が無い`).not.toBeNull();

      // script 系ディレクティブだけを取り出す (style-src は 'unsafe-inline' を正当に使うため)。
      // ここは素朴な文字列処理でよい。取りこぼしても**誤って赤くなるだけ**で、
      // 緑のまま見逃す側には倒れない（自前パーサが危険だったのは逆向きだったから）
      const scriptDirectives = (policy ?? "")
        .split(";")
        .map((d) => d.trim())
        .filter((d) => /^(script-src|script-src-elem|default-src)\b/i.test(d))
        .join(" ");

      // インライン script を丸ごと許す指定が入っていないこと。
      // これが入ると sha256 は無意味になり、ハッシュ不一致のテストも一緒に緑になる
      expect(
        scriptDirectives.toLowerCase(),
        `${path} の script 系ディレクティブに 'unsafe-inline' がある: ${scriptDirectives}`,
      ).not.toContain("'unsafe-inline'");
      // eval も同様に塞いだままであること
      expect(
        scriptDirectives.toLowerCase(),
        `${path} の script 系ディレクティブに 'unsafe-eval' がある: ${scriptDirectives}`,
      ).not.toContain("'unsafe-eval'");

      // インライン script を持つページは、ハッシュで許可していること
      if (inlineScriptCount > 0) {
        expect(
          scriptDirectives.toLowerCase(),
          `${path} はインライン script を ${inlineScriptCount} 個持つのに ` +
            `script 系ディレクティブに sha256 が無い: ${scriptDirectives}`,
        ).toContain("sha256-");
      }
    });
  }

  // 「script が実際に実行されたか」を直接見る網は、あえてここに置かない。
  // sections.spec.ts の「portfolio.json 由来の CI バッジが主力カードに描画される」が
  // 既に同じことを**より強く**確かめている (バッジの有無だけでなく 3 枚すべての
  // ラベル内容まで検証する)。同じ確認をここへ写すと、より弱い重複が 1 つ増えるだけで、
  // バッジのマークアップを変えたときに直す場所が 2 か所になる (§6 DRY)。
  //
  // スクロールして遅延読み込み (loading="lazy" 等) を発火させる処理も置いていない。
  // 現状 index.html / resume.html に lazy 画像も CSS の url() 参照も 1 つも無く、
  // 唯一の通信は DOMContentLoaded 時の fetch("data/portfolio.json") で、
  // 最初の networkidle までに完了する。存在しない事情のために毎回 10 秒近く積むのは
  // §6「将来を見越した過度な抽象化を避ける」に反する。
  // **遅れて要求されるリソースを足すときは、ここに一巡させる処理を戻すこと**
  // (scripts/lib/scroll-priming.mjs の primeScrollAnimations が使える)。
});
