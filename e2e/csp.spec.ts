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
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";

// このファイル (e2e/) の 1 つ上＝リポジトリのルート。
// Playwright は spec を CJS へ変換して読み込むため import.meta は使えず、__dirname を使う
const REPO_ROOT = join(__dirname, "..");

/**
 * 走査しない名前を **.htmlvalidateignore を唯一の源として**読む。
 *
 * CI の html-validate (`**\/*.html`) と同じ範囲を見るためで、ここに写しを持つと
 * 「構文検査はされるのに CSP は検査されない」ページが黙って生まれる。
 *
 * 落とすのは**末尾の `/`**（ディレクトリ指定）だけ。**先頭の `/`（ルート固定）は
 * わざと残す** —— findPages は素の名前しか照合できずルート固定を再現できないので、
 * `/build/` と書かれたら「html-validate はルート直下だけを外すのに、こちらは
 * 深い階層の build も飛ばす」というずれになる。残しておけば
 * UNSUPPORTED_IGNORE_ENTRIES が `/` を見て落とす（fail-closed）。
 *
 * @returns コメント・空行を除き、末尾の / を落とした指定の配列
 */
function readHtmlValidateIgnore(): string[] {
  // ファイルを UTF-8 で読み、行に分ける
  return (
    readFileSync(join(REPO_ROOT, ".htmlvalidateignore"), "utf8")
      .split("\n")
      // 前後の空白を落とす
      .map((line) => line.trim())
      // コメント行と空行を落とす
      .filter((line) => line && !line.startsWith("#"))
      // 末尾の / を落として素の名前へそろえる
      .map((line) => line.replace(/\/$/, ""))
  );
}

// 走査しない名前（上の関数が唯一の解釈箇所）
const IGNORED_NAMES = readHtmlValidateIgnore();

// この導出が扱えるのは「単一のディレクトリ名」だけ。html-validate は gitignore の
// 書式をひととおり解釈するので、`docs/legacy/` や `**/generated/` のような書き方を
// されると **こちらだけが黙って無視して範囲がずれる**（構文検査はされるのに
// CSP は検査されない、という状態がまさにこの網の防ぎたいもの）。
// 黙ってずれるより落ちる方が良いので、扱えない書き方を見つけたら fail-closed にする
// 判定は「素の名前 1 つ」に見えるかどうか。`/` `*` に加えて `!`（否定）や `?` `[]`（グロブ）も弾く。
// とくに `!` は**意味を反転させる**唯一の記法で、`docs/` と `!docs` を並べると
// html-validate は docs を検査対象へ戻すのにこちらは skip したまま、という
// 「構文検査はされるのに CSP は検査されない」状態を作れてしまう
const UNSUPPORTED_IGNORE_ENTRIES = IGNORED_NAMES.filter((e) => /[/*?[\]!]/.test(e));

// **gitignore の書式は自前で解釈しない。** 否定 (`!`)・グロブ (`**/dist/`)・
// 入れ子 (`docs/generated/`)・ルート固定 (`/build/`)・末尾スラッシュの有無・
// 名前に含まれるドット (`build.v2`) …と場合分けが尽きず、実際この検査は
// 自前で分類していた版で 5 つの穴（素通り 3・行き止まり 2）を出した。
// これは CSP の文法を正規表現で再実装しようとしたのと**同じ altitude の誤り**なので、
// 同じ手当てをする ——**判定は git 自身に任せる**。
//
// 見るのは「findPages が拾ったページを git が無視しているか」だけ。
// git が無視しているなら、それは配信されない生成物なのに html-validate と
// この検査だけが見に行っている状態で、**生成物のある手元では赤・生成物が存在しない
// 新規チェックアウトの CI では緑**という、いちばん原因を追いにくい食い違いになる。
// 対処は 1 つ（.htmlvalidateignore へも足す）なので、行き止まりも起こらない。

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
      if (IGNORED_NAMES.includes(entry.name) || entry.name.startsWith(".")) continue;
      // 下の階層で見つかったページを足す
      found.push(...findPages(join(dir, entry.name), relative));
      // このエントリの処理は終わり
      continue;
    }
    // 拡張子が .html でなければ対象外
    if (!entry.name.toLowerCase().endsWith(".html")) continue;
    // 隠しファイル (.preview.html 等) も飛ばす。ディレクトリ側と判定をそろえるだけでなく、
    // **html-validate の `**\/*.html` が dotfile を拾わない**ため、ここで拾うと
    // 「html-validate は対象外と判断したのに CSP テストだけが赤くなる」ずれになる
    // （実測: ルートに .preview.html を置くと html-validate は exit 0、こちらだけ落ちた）
    if (entry.name.startsWith(".")) continue;
    // 除外指定はファイル名にも効かせる。ディレクトリ名にしか適用しないと、
    // `legacy.html` のような 1 ファイルの除外を html-validate だけが尊重し、
    // こちらは開きに行って「CSP が無い」と赤くする（対象外と宣言したファイルなのに）
    if (IGNORED_NAMES.includes(entry.name)) continue;
    // **実体が通常のファイルであること**まで確かめる。`zzz.html` という名前のディレクトリが
    // あると、それを開いた 404 応答には CSP が無いので「違反ゼロ」で緑になってしまう。
    // entry.isFile() だけで見るとシンボリックリンクが false になり、
    // 配信はされるのに検査対象から黙って落ちるので、statSync で実体をたどる
    // throwIfNoEntry: false を付けるのは、**壊れたシンボリックリンク**で statSync が
    // 例外を投げ、PAGES の計算（module 評価時）ごと落ちるのを避けるため。
    // そうなると「導出が壊れていない」ガードを含む全テストが 1 つも動かず、
    // 生の ENOENT だけが出る。リンク切れのファイルは配信もされないので飛ばして正しい
    const stat = statSync(join(dir, entry.name), { throwIfNoEntry: false });
    if (stat?.isFile()) found.push(relative);
  }
  // 見つかったページのパスを返す
  return found;
}

// load 後の通信が落ち着くのを待つ上限（ミリ秒）。
// 外部フォントが遅い環境でも、ここで待ち続けないようにするための頭打ち
const SETTLE_TIMEOUT_MS = 3000;

// 検査対象のページ一覧
const PAGES: ReadonlyArray<string> = findPages(REPO_ROOT);

/**
 * 渡したページのうち **git が無視しているもの**を返す。
 *
 * gitignore の解釈は git 自身に任せる（上のコメント参照）。`git check-ignore --stdin` は
 * 無視されるパスだけを出力し、1 件も無ければ終了コード 1 で終わる。
 *
 * @param paths baseURL 起点のページパス（先頭 "/" 付き）
 * @returns git が無視しているページのパス（同じ書式）
 */
function gitIgnoredPages(paths: ReadonlyArray<string>): string[] {
  // 対象が無ければ git を呼ぶ必要も無い
  if (paths.length === 0) return [];
  try {
    // リポジトリ相対のパスに直して git へ流し込む
    const out = execFileSync("git", ["check-ignore", "--stdin"], {
      cwd: REPO_ROOT,
      input: paths.map((p) => p.replace(/^\//, "")).join("\n"),
      encoding: "utf8",
    });
    // 出力（無視されたパス）を元の書式へ戻して返す
    return out.split("\n").filter(Boolean).map((p) => `/${p}`);
  } catch (err) {
    // 終了コード 1 は「1 件も無視されていない」＝正常
    if ((err as { status?: number }).status === 1) return [];
    // それ以外（git が無い・リポジトリでない等）は前提が崩れているので落とす。
    // 握り潰すと「無視ゼロ＝緑」になり、この検査が黙って無効になる（fail-closed）
    throw err;
  }
}

// findPages が拾ったのに git が無視しているページ（＝ .htmlvalidateignore への足し忘れ）
const GIT_IGNORED_PAGES = gitIgnoredPages(PAGES);

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
  // CSP meta より前に置かれている（＝ポリシーに支配されない）script 要素の数
  ungovernedScriptCount: number;
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

  // 対象ページを開く。waitUntil は既定の "load"。
  //
  // **"domcontentloaded" にしても速くならない（実測済み。試して戻した）。**
  // index.html は <head> で Google Fonts の stylesheet を読んでおり、これは
  // パーサをブロックする。body 末尾のインライン script は保留中の stylesheet を
  // 待ってからでないと実行できず、DOMContentLoaded はその script を待つ ——
  // つまり DOMContentLoaded 自体が stylesheet の取得後にしか発火しない。
  // 実測: load 12,824ms / domcontentloaded 12,610ms（差はほぼ無い）/
  // commit 9ms / fonts.googleapis.com を止めた domcontentloaded 24ms。
  // 速くしたいなら第三者フォントを止めるしかないが、それをすると
  // **style-src の fonts.googleapis.com が一度も試されなくなる**（許可を外しても緑）。
  // 待ち時間と引き換えに得ているのはその検査なので、"load" のまま待つ。
  //
  // 代償: フォント配信が 30 秒（goto の既定タイムアウト）以上詰まると、CSP と
  // 無関係な理由で赤くなる。これは**誤って赤くなる側**なのでこの検査の方針上は許容する
  // （緑のまま見逃す側に倒すよりよい。CI は retries: 2 で一過性のものは吸収される）
  const response = await page.goto(path);
  // 200 以外はページが存在しない (404 の本文には CSP が無いので「違反ゼロ」で緑になってしまう)
  expect(response?.status(), `${path} が ${response?.status()} を返した`).toBe(200);

  // load 後に走る同一オリジンの通信（DOMContentLoaded の fetch("data/portfolio.json")）が
  // 落ち着くのを待つ。上限を付けるのは、外部フォントが遅い環境で待ち続けないため。
  // 時間切れは異常ではない（待つ価値のある通信は既に終わっている）ので、
  // 例外にせず先へ進む —— 握り潰しではなく「上限付きの待ち」であることを明示する
  await page.waitForLoadState("networkidle", { timeout: SETTLE_TIMEOUT_MS }).catch((err) => {
    // **時間切れだけを飲み込む。** 何でも握り潰すと（§6 違反）、ページのクラッシュや
    // ブラウザの終了までここで消え、続く page.evaluate が
    // 「Target page has been closed」という二次的で分かりにくい失敗に化けて、
    // 本当の原因が報告に残らない。時間切れ以外はそのまま投げ直す
    if (!(err instanceof Error) || err.name !== "TimeoutError") throw err;
    // 時間切れ。外部リソースが残っているだけなので、このまま観測へ進む
  });

  // **残っている境界（意図的。塞ごうとして遅くしないこと）。**
  // 「違反ゼロ」で確実に見えるのは *解析中に起きる違反*（インライン script の拒否・
  // 静的に書かれた <script src> / <link> の拒否）と、SETTLE_TIMEOUT_MS 内に終わる
  // 同一オリジンの通信（fetch("data/portfolio.json")）まで。
  // **CSS が二次的に要求するリソース——具体的には Google Fonts の webfont——の
  // font-src 違反はここでは観測できない（推測ではなく実測）。**
  // font-src を 'none' にした index.html でこのスペックを流すと 3 件とも緑で通る。
  // fonts.googleapis.com の stylesheet を取得してから初めて font ファイルを要求するため
  // 第三者ドメインへの往復が 2 回積み上がり、上限内に終わらないことがあるため。
  // 上限を伸ばして待てば見えるが、CSP と無関係なネットワーク事情でテストが遅く・
  // 不安定になり、しかも「十分待てたか」は環境依存なので確実にはならない。
  //
  // この穴は **e2e/visual.spec.ts が塞いでいる**。同スペックは全ページを
  // toHaveScreenshot で比較する。webfont がブロックされると代替フォントで描画され、
  // **実測でページの 7.2% のピクセルが変わる**（fonts.gstatic.com を止めて撮った
  // 全画面と正常時の全画面を比較した値）。playwright.config.ts の許容差は
  // maxDiffPixelRatio: 0.02（2%）なので 3.6 倍の余裕で落ちる。
  // なお**ページの高さは変わらない**ので、サイズ不一致による即失敗は当てにできない。
  // **したがってこの穴を塞いでいるのは許容差 2% という設定そのものである。**
  // visual.spec.ts を消す・許容差を 7% 超へ広げる のどちらも、font-src の
  // 検出を道連れにする（「見た目の回帰テストだから」と軽く触らないこと）。

  // ページの状態を 1 回の評価でまとめて取り出す
  return page.evaluate(() => ({
    // 溜まった違反
    violations: (window as unknown as { __cspViolations: CspViolation[] }).__cspViolations,
    // CSP meta の中身。**HTML の解析はブラウザが済ませている**ので、
    // コメント内の meta や属性の並び・実体参照といった細部を自前で扱う必要がない
    // **head の中だけを見る**。<body> に置かれた CSP meta はブラウザが無視するので、
    // document 全体から探すと「効いていないポリシー」を「CSP がある」と読んでしまう
    // （実際、body に偽ハッシュの meta を置いたページが両方のテストを素通りした）
    policy:
      document.head
        .querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy" i]')
        ?.getAttribute("content") ?? null,
    // **CSP meta より前に現れる script の数**。meta で配信する CSP は
    // 「その meta より後ろ」しか支配しないため、head の meta より上に script を置くと
    // ブラウザは無制限に実行し、違反も起きない（＝違反ゼロで緑のまま素通りする）。
    // 実際に meta の直前へ script を 1 行足したページが全テストを通った。
    // 外部 script も同じく素通りするので、src の有無を問わず数える
    ungovernedScriptCount: (() => {
      // 判定の基準になる CSP meta を取る
      const meta = document.head.querySelector('meta[http-equiv="Content-Security-Policy" i]');
      // すべての script 要素を集める
      const scripts = [...document.querySelectorAll("script")];
      // meta が無ければ、そもそも全部が支配されていない
      if (!meta) return scripts.length;
      // meta より後ろに無い（＝前にある）script を数える
      return scripts.filter(
        (el) => !(meta.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING),
      ).length;
    })(),
    // script-src に支配されるインライン script の数。
    // 判定は**「実行されないと分かっている type の許可リスト以外はすべて対象」**という
    // 向きにする。実行される MIME を列挙する向きにすると、綴りを 1 つ漏らすたびに
    // （HTML 仕様の JavaScript MIME には text/jscript や text/javascript1.5 まである）
    // 「インライン script があるなら sha256 が要る」の検査が**黙って無効**になり、
    // sha256 を nonce へ置き換えても緑になる。未知の type は対象へ入れて
    // 誤って赤くなる側へ倒す（すぐ気づけるので安全）。
    // importmap / speculationrules は JS として評価されないが script-src の対象なので含める
    inlineScriptCount: [...document.querySelectorAll("script:not([src])")].filter((el) => {
      // type 属性を小文字・前後空白なしへ揃える（属性が無ければ空文字＝既定の JavaScript）
      const type = (el as HTMLScriptElement).type.trim().toLowerCase();
      // script-src に支配されないと分かっているものだけを除く
      return !["application/ld+json", "application/json", "text/template", "text/html"].includes(
        type,
      );
    }).length,
  }));
}

test.describe("Content-Security-Policy", () => {
  test("検査対象の導出が壊れていない", () => {
    // 導出が壊れて 0 件になると、下のループが 1 つもテストを作らず
    // 「違反ゼロ＝緑」に見えてしまう。導出そのものを fail-closed にする
    // (CI の html-validate も対象 0 件なら exit 1 で落ちる。挙動をそろえる)
    expect(PAGES.length, "リポジトリから HTML ページを 1 枚も導出できなかった").toBeGreaterThan(0);
    // .htmlvalidateignore に、この導出が解釈できない書き方が入っていないこと。
    // 黙って無視すると html-validate との範囲がずれる（上の定数のコメント参照）
    expect(
      UNSUPPORTED_IGNORE_ENTRIES,
      ".htmlvalidateignore に、e2e/csp.spec.ts の導出が扱えない書き方があります" +
        "（対応しているのは単一のディレクトリ名だけ）。findPages を拡張するか、書き方を単純にしてください",
    ).toEqual([]);
    // git が無視しているページを拾っていないこと（判定は git 自身に任せる。上のコメント参照）。
    // 拾ってしまうと、生成物のある手元では「第三者の HTML に CSP が無い」と赤くなり、
    // 生成物が存在しない新規チェックアウトの CI は緑のまま ——
    // CI と手元が食い違う、いちばん原因を追いにくい形になる
    expect(
      GIT_IGNORED_PAGES,
      "git が無視しているページを CSP の検査対象に拾っています。" +
        "html-validate は .gitignore を読まないので、生成物は .htmlvalidateignore にも" +
        "書いてください（そうしないと、このテストも `npx html-validate \"**/*.html\"` も" +
        "手元でだけ赤くなります）",
    ).toEqual([]);
  });

  // 対象ページを 1 枚ずつ検証する。
  // **1 ページにつき 1 回だけ開く**。以前は「違反ゼロ」と「方式の維持」を別テストにしていたが、
  // どちらも同じ 1 回の観測から導ける事実なので、ページを 2 回開くのは待ち時間の二重払いだった
  // （networkidle は Google Fonts の取得を待つので 1 回あたり十数秒かかる）。
  // 独立した検査は expect.soft で並べ、1 つ落ちても残りの結果が見えるようにする
  for (const path of PAGES) {
    test(`${path} の CSP が壊れていない`, async ({ page }) => {
      // ページを開いて観測する（1 回だけ）
      const { violations, policy, inlineScriptCount, ungovernedScriptCount } = await observePage(
        page,
        path,
      );

      // --- 1. ブラウザが実際に何もブロックしていないこと ---
      // 失敗時に「何がブロックされたか」がそのまま読めるメッセージを組み立てる
      const detail = violations
        .map((v) => `${v.directive} が ${v.blockedURI} をブロック`)
        .join(" / ");
      // script まわりの違反は「CSP の sha256 がインライン script と食い違っている」ことが
      // 圧倒的に多いので、直し方を失敗メッセージに添えておく
      expect
        .soft(
          violations,
          `${path} で CSP 違反が発生した: ${detail}\n` +
            "インライン script を編集した場合は、index.html の CSP meta 内 script-src の\n" +
            "sha256 を新しい本文のハッシュへ更新してください " +
            "(DevTools のコンソールに必要な値が出ます)。",
        )
        .toEqual([]);

      // --- 2. 方式（ハッシュ許可）が保たれていること ---
      // 「違反ゼロ」だけを見ていると、meta を消せば違反も消えて緑になる。
      // content="" も同じで、空のポリシーは何も制限しないのに null ではないため
      // 「CSP がある」と読めてしまう。中身があることまで確かめる
      expect
        .soft(
          (policy ?? "").trim(),
          `${path} に中身のある Content-Security-Policy の meta が無い（head の中を見ています）`,
        )
        .not.toBe("");

      // script 系ディレクティブだけを取り出す (style-src は 'unsafe-inline' を正当に使うため)。
      // **`script-src-attr` を書き並べていないが、これも拾える**（`script-src` の直後の
      // `\b` がハイフンとの境界に当たるため）。インラインのイベントハンドラを解禁する
      // `script-src-attr 'unsafe-inline'` を足す変異が実際に赤くなることを確認済み。
      // ここは素朴な文字列処理でよい。取りこぼしても**誤って赤くなるだけ**で、
      // 緑のまま見逃す側には倒れない（自前パーサが危険だったのは逆向きだったから）
      const scriptDirectives = (policy ?? "")
        .split(";")
        .map((d) => d.trim())
        .filter((d) => /^(script-src|script-src-elem|default-src)\b/i.test(d))
        .join(" ");

      // script を支配するディレクティブが 1 つも無ければ、ポリシーは script を制限していない
      expect
        .soft(
          scriptDirectives,
          `${path} の CSP に script を支配するディレクティブ` +
            "（script-src / script-src-elem / default-src）が無い",
        )
        .not.toBe("");

      // インライン script を丸ごと許す指定が入っていないこと。
      // これが入ると sha256 は無意味になり、ハッシュ不一致のテストも一緒に緑になる
      expect
        .soft(
          scriptDirectives.toLowerCase(),
          `${path} の script 系ディレクティブに 'unsafe-inline' がある: ${scriptDirectives}`,
        )
        .not.toContain("'unsafe-inline'");
      // eval も同様に塞いだままであること
      expect
        .soft(
          scriptDirectives.toLowerCase(),
          `${path} の script 系ディレクティブに 'unsafe-eval' がある: ${scriptDirectives}`,
        )
        .not.toContain("'unsafe-eval'");

      // CSP meta より前に script が置かれていないこと。
      // meta の CSP は「それより後ろ」しか支配しないので、前に置かれた script は
      // 無制限に実行され、違反イベントも起きない（違反ゼロのまま緑を通る）
      expect
        .soft(
          ungovernedScriptCount,
          `${path} に CSP meta より前へ置かれた script が ${ungovernedScriptCount} 個ある。` +
            "meta の CSP はそれより後ろしか支配しないため、この script は無制限に実行される。" +
            "CSP meta を <head> の先頭側へ移すか、script を meta より後ろへ移してください",
        )
        .toBe(0);

      // インライン script を持つページは、ハッシュで許可していること
      if (inlineScriptCount > 0) {
        expect
          .soft(
            scriptDirectives.toLowerCase(),
            `${path} はインライン script を ${inlineScriptCount} 個持つのに ` +
              `script 系ディレクティブに sha256 が無い: ${scriptDirectives}`,
          )
          .toContain("sha256-");
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
