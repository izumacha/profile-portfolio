/**
 * CSP の script-src に書いた sha256 ハッシュが、実際のインライン script と一致するかを検査する。
 *
 * なぜ要るのか:
 * index.html は GitHub Pages が HTTP ヘッダを付けられないため、CSP を <meta> で配信している。
 * script-src は 'unsafe-inline' を使わず、インライン script 本文の base64(SHA-256(...)) だけを
 * 許可する形になっている。
 * つまり **インライン script を 1 文字でも編集するとハッシュが合わなくなり、ブラウザが
 * その script の実行を拒否する**。壊れ方が悪質で、
 *   - HTML の構文としては正しいので `html-validate` は緑のまま通る
 *   - サーバーもエラーを返さない（拒否するのはブラウザで、DevTools のコンソールにしか出ない）
 *   - 画面は「JS が一切動かないただの静的ページ」になるだけで、崩れて見えるわけではない
 * ため、気づかないまま公開されうる（実際にこの検査を足す直前、インライン script へ
 * console.error を 1 行足しただけで Live self-proof のバッジが全滅した）。
 *
 * 現状 e2e（`npm run test:e2e`）が間接的に検知はする。バッジの描画を確かめるテストが
 * たまたま script の実行に依存しているためで、**script に依存するテストが 1 本も無い
 * 領域を編集した場合は素通りする**。ハッシュの一致そのものはブラウザを起動しなくても
 * 確かめられるので、専用の検査として切り出しておく（§14 CI で機械的に落とす）。
 *
 * 検査の中身（両ページに **同じ規則** を適用する。ページごとに分岐を書かない）:
 *   A. script-src の sha256 トークンの集合と、実行対象インライン script のハッシュの集合が
 *      過不足なく一致すること。1 対 1 で突き合わせるので、
 *      「ハッシュが古い」「script を足したのにトークンを足していない」
 *      「script を消したのにトークンが残っている」がすべて同じ 1 つの規則で落ちる。
 *   B. インライン script も外部 script も持たないページは script-src 'none'（最小権限）。
 *
 * **ページごとに別の関数を書かない**のが要点。以前は index.html だけがハッシュを検証し、
 * resume.html は「'none' を宣言しているか」しか見ていなかったため、
 * resume.html が script を持って 'none' をやめた瞬間（＝この検査自身が案内する移行先）に
 * そのページのハッシュを誰も検証しなくなる fail-open があった。規則 A を共通に掛ければ、
 * どのページがどちらの状態になっても検証が外れない。
 *
 * 依存を増やさない（§9 サプライチェーン最小化）ため外部パッケージは使わず、Node 標準だけで組み立てる。
 */

// SHA-256 を計算するための Node 標準モジュール
import { createHash } from "node:crypto";
// HTML ファイルを読むための Node 標準モジュール（Promise 版）
import { readdir, readFile } from "node:fs/promises";
// このファイルの位置からリポジトリのルートを求めるために使う
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// このスクリプトが置かれている scripts/ の 1 つ上＝リポジトリのルート
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 検査対象のページを **リポジトリルートの *.html から導出する**。
 *
 * 一覧を手で書き並べない理由は、この検査自身が塞いだ fail-open とまったく同じ。
 * 写しを持つと、3 枚目の HTML を足した人が一覧への追加を忘れた瞬間、
 * そのページだけ**黙って**検査対象から外れる（緑のまま通る）。
 * ルートを読んで拾えば、追加漏れという状態がそもそも作れない。
 *
 * @returns {Promise<string[]>} ルート直下の HTML ファイル名（名前順）
 */
async function findPages() {
  // ルート直下のファイル・ディレクトリ名を読み取る
  const entries = await readdir(REPO_ROOT);
  // 拡張子が .html のものだけを名前順に採る
  return entries.filter((name) => name.toLowerCase().endsWith(".html")).sort();
}

// HTML を左から順に読み進めるための走査用パターン。
// **コメントと script を 1 本の交替（|）にまとめている**のが要点。正規表現の交替は
// 「最も左で始まる候補」を採るため、`<!-- ... <script> ... -->` のように
// コメントの中に `<script` が現れても、先に始まるコメント側が丸ごと消費される。
// コメントを事前に削除する方式にしないのは、JS の本文に `<!--`（レガシーな行コメント）が
// 書かれていた場合に script 本文を壊してしまうため。
// この形にする前は、`<!-- 以下が唯一の <script> ブロック -->` のような
// **日本語の注釈を 1 行足すだけ**でコメント途中から script として拾い、
// 本来正しいページに対して「ハッシュが不一致」と報告したうえ、
// **貼り替えると CI が緑になるのにブラウザは script を拒否し続ける**間違った値を出していた
// （このリポジトリの resume.html は実際に `NO <script>` と書いたコメントを持っている）。
// 属性部分を `(?:"[^"]*"|'[^']*'|[^>"'])*` で書くのは、**引用符の中の `>` を
// タグの終わりと誤認しない**ため。`[^>]*` だと `<script onerror="if(a>b)f()">` を
// 最初の `>` で切ってしまい、`b">console.log(2)` のような誤った本文をハッシュして
// 「追加する値」として提示する ——貼り替えると検査だけ緑になり、ブラウザは拒否し続ける
// （上のコメントが塞いだ壊れ方が別経路で復活する）。
const HTML_SCAN_RE =
  /<!--[\s\S]*?-->|<script\b((?:"[^"]*"|'[^']*'|[^>"'])*)>([\s\S]*?)<\/script\s*>/gi;

// 開始タグの属性文字列から「名前」と「値」を 1 組ずつ取り出すパターン。
// 値は "..." / '...' / 引用符なし のいずれにも対応する
const ATTR_RE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

// CSP の meta タグから content 属性の中身を取り出すパターン（全件を拾うので g 付き）
const CSP_META_RE =
  /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/gi;

// インライン script 要素を支配するディレクティブを、優先度の高い順に並べたもの。
// CSP3 では script 要素は script-src-elem が支配し、あれば script-src は**無視される**。
// どちらも無ければ default-src へフォールバックする。
// script-src だけを見ていた頃は、`script-src-elem 'self'`（sha256 なし）を足すだけで
// 検査が緑のままブラウザがインライン script を拒否する fail-open があった
const SCRIPT_DIRECTIVE_PRIORITY = ["script-src-elem", "script-src", "default-src"];

// script-src ディレクティブに書かれた sha256 トークンを拾うパターン
const SHA256_TOKEN_RE = /'sha256-([A-Za-z0-9+/=]+)'/g;

// ブラウザが JavaScript として実行する type の一覧（小文字で比較する）。
// 空文字は type 属性そのものが無い場合。module / importmap も script-src の対象なので含める。
// **許可リスト方式にする**のが要点。以前は「ld+json だけ除外」という拒否リストだったため、
// application/json のようなデータ島を足すと実行対象として数えられ、
// 「ブラウザが実行しないブロックのために CSP へ sha256 を足せ」という誤った案内を出していた
const EXECUTABLE_SCRIPT_TYPES = new Set([
  "", // type 属性なし（既定で JavaScript）
  "module", // ES モジュール
  "importmap", // インポートマップ（script-src の対象）
  "text/javascript",
  "application/javascript",
  "text/ecmascript",
  "application/ecmascript",
  "text/jscript",
  "application/x-javascript",
  "application/x-ecmascript",
  "text/x-javascript",
]);

// ブラウザが実行しない（＝script-src に支配されない）と分かっている type の一覧。
// ここにも上にも無い type は「分類されていない」として落とす（fail-closed）
const NON_EXECUTABLE_SCRIPT_TYPES = new Set([
  "application/ld+json", // 構造化データ（index.html が実際に持っている）
  "application/json", // データ島
  "text/template", // テンプレート置き場
  "text/html", // テンプレート置き場（別表記）
  "speculationrules", // 投機的読み込みのルール
]);

// 見つかった問題を溜める配列（1 件目で打ち切らず、まとめて報告する）
const problems = [];

/**
 * 開始タグの属性文字列を、小文字のキーを持つ入れ物へ変換する。
 *
 * @param {string} attrText `<script` と `>` の間の文字列
 * @returns {Map<string, string>} 属性名（小文字）→ 属性値
 */
function parseAttributes(attrText) {
  // 結果を溜める入れ物を用意する
  const attrs = new Map();
  // 属性を 1 組ずつ取り出して詰める
  for (const m of attrText.matchAll(ATTR_RE)) {
    // 属性名は大文字小文字を区別しないので小文字へ揃える
    const name = m[1].toLowerCase();
    // 引用符の種類によって値の入る場所が変わるので、最初に見つかったものを採る（値なしは空文字）
    attrs.set(name, m[2] ?? m[3] ?? m[4] ?? "");
  }
  // 組み立てた入れ物を返す
  return attrs;
}

/**
 * 文字列の SHA-256 を CSP のトークン形式（base64）で返す。
 *
 * ブラウザは「script 開始タグと終了タグの間の文字列」を UTF-8 のバイト列としてハッシュする。
 * ここでは **正規化を一切しない**（受け取った文字列をそのまま計算する）。
 *
 * 改行の扱いは呼び出し側の CR 検査に任せる。この関数で CRLF を LF へ潰すと、
 * .gitattributes が外れる・対象外の拡張子へ移すなどで **blob が本当に CRLF だった**
 * 場合に「配信物は CRLF なのに LF 基準で一致と報告する」＝壊れているのに緑、という
 * 逆向きの fail-open になる（§10）。落とす側に倒しておけば .gitattributes の
 * 効き目そのものも機械的に確かめられる。
 *
 * @param {string} text ハッシュ対象の script 本文
 * @returns {string} base64 エンコードした SHA-256 値
 */
function sha256Base64(text) {
  // 受け取った文字列を UTF-8 のバイト列としてそのままダイジェストを取る
  return createHash("sha256").update(text, "utf8").digest("base64");
}

/**
 * HTML から script 要素を拾い、「実行対象のインライン script」と「外部 script」に仕分ける。
 *
 * @param {string} html 対象ファイルの中身
 * @param {string} label エラーメッセージに出すファイル名
 * @returns {{ inlineBodies: string[], externalCount: number }} 仕分け結果
 */
function collectScripts(html, label) {
  // 実行対象のインライン script の本文を溜める配列
  const inlineBodies = [];
  // 外部 script（src 付き）の件数
  let externalCount = 0;

  // コメントを飛ばしながら script 要素だけを拾う
  for (const m of html.matchAll(HTML_SCAN_RE)) {
    // コメント側が一致した回は捕獲グループが未定義なので読み飛ばす
    if (m[1] === undefined) continue;
    // 開始タグの属性を読み取る
    const attrs = parseAttributes(m[1]);

    // src を持つものは外部 script。インラインではないのでハッシュの対象外
    // （`data-src` のような別属性を src と取り違えないよう、キーの完全一致で見る）
    if (attrs.has("src")) {
      externalCount += 1;
      continue;
    }

    // type を小文字・前後空白なしへ揃える（属性が無ければ空文字）
    const type = (attrs.get("type") ?? "").trim().toLowerCase();

    // 実行しないと分かっている type は、script-src の対象外なので数えない
    if (NON_EXECUTABLE_SCRIPT_TYPES.has(type)) continue;

    // どちらの一覧にも無い type は、実行されるのか判断できないので落とす（fail-closed）。
    // 勝手に「実行しない」と決めると、実行される type が黙って検証対象から外れる
    if (!EXECUTABLE_SCRIPT_TYPES.has(type)) {
      problems.push(
        `${label}: 分類されていない script の type="${type}" があります。` +
          " scripts/check-csp-hash.mjs の EXECUTABLE_SCRIPT_TYPES /" +
          " NON_EXECUTABLE_SCRIPT_TYPES のどちらかへ追加してください。",
      );
      continue;
    }

    // ここまで来たら実行対象のインライン script。本文をハッシュ対象として溜める
    inlineBodies.push(m[2]);
  }

  // 仕分け結果を返す
  return { inlineBodies, externalCount };
}

/**
 * HTML から「インライン script 要素を実際に支配するディレクティブ」を取り出す。
 *
 * script-src だけを見てはいけない。CSP3 では script 要素は script-src-elem が支配し、
 * それがあるときは script-src は**無視される**。つまり `script-src-elem 'self'` を
 * 足すだけで、sha256 を並べた script-src は効かなくなる。
 *
 * また CSP の meta が複数あるとブラウザは**すべてのポリシーを重ねて**強制する
 * （通るのは全ポリシーが許可したものだけ）。1 つ目だけ読むと、2 つ目で
 * `script-src 'none'` を足された場合に見落とす。積集合の再現までは踏み込まず、
 * 複数あった時点で落とす（fail-closed。このリポジトリは 1 つしか持たない）。
 *
 * @param {string} html 対象ファイルの中身
 * @param {string} label エラーメッセージに出すファイル名
 * @returns {string | null} 実効ディレクティブの値（決められなければ null）
 */
function readEffectiveScriptDirective(html, label) {
  // CSP の meta タグを全件拾う（正規表現は g 付きなので matchAll で回せる）
  const metas = [...html.matchAll(CSP_META_RE)];
  // meta ごと無ければ検査の前提が崩れているので落とす（fail-closed）
  if (metas.length === 0) {
    problems.push(`${label}: Content-Security-Policy の meta タグが見つかりません。`);
    return null;
  }
  // 複数あるとポリシーが重なり、この検査の前提（1 つの script-src を見れば足りる）が崩れる
  if (metas.length > 1) {
    problems.push(
      `${label}: Content-Security-Policy の meta タグが ${metas.length} 個あります。` +
        " ブラウザは全ポリシーを重ねて強制するため、1 つだけを見るこの検査では正しく判定できません。" +
        " meta を 1 つにまとめるか、scripts/check-csp-hash.mjs を積集合に対応させてください。",
    );
    return null;
  }

  // ディレクティブは ";" 区切りなので分割し、前後の空白を落とす（空要素は捨てる）
  const directives = metas[0][1].split(";").map((d) => d.trim()).filter(Boolean);
  // 優先度の高い順に、最初に見つかったものが実効ディレクティブになる
  for (const name of SCRIPT_DIRECTIVE_PRIORITY) {
    // 「値なしの単独指定」と「値付き」の両方を拾う
    const found = directives.find((d) => d === name || d.startsWith(`${name} `));
    // 見つかったらそれを返す（script-src-elem があれば script-src は見ない）
    if (found) return found;
  }

  // 3 つとも無いと script 要素が何に支配されるか決まらないので落とす
  problems.push(
    `${label}: CSP に ${SCRIPT_DIRECTIVE_PRIORITY.join(" / ")} のいずれもありません。`,
  );
  return null;
}

/**
 * 1 ページ分を検査する（両ページに同じ規則を掛ける）。
 *
 * @param {string} fileName リポジトリルートからのファイル名
 */
async function checkPage(fileName) {
  // ファイルの中身を UTF-8 で読み込む
  const html = await readFile(join(REPO_ROOT, fileName), "utf8");

  // 改行に CR が混ざっていたら、ハッシュの計算前に落とす（§10）。
  // 配信されるのはコミット済みの blob なので、作業ツリーが CRLF だとブラウザが
  // 計算する値とここで計算する値が食い違う。正規化して合わせるのではなく落とすのは、
  // 「blob が本当に CRLF なのに緑」という逆向きの取りこぼしを作らないため。
  // .gitattributes の `*.html text eol=lf` が効いていればここには来ない
  if (html.includes("\r")) {
    problems.push(
      `${fileName}: 改行に CR が含まれています（CRLF）。` +
        " 配信されるのはコミット済みの blob なので、このままだと CSP の sha256 が食い違います。" +
        " .gitattributes の `*.html text eol=lf` が効いているか確認し、LF で保存し直してください。",
    );
    return;
  }

  // script 要素を仕分ける
  const { inlineBodies, externalCount } = collectScripts(html, fileName);
  // インライン script を実際に支配するディレクティブを取り出す
  const scriptSrc = readEffectiveScriptDirective(html, fileName);
  // 取り出せなければ（理由は readEffectiveScriptDirective が既に記録済み）ここで打ち切る
  if (!scriptSrc) return;

  // script-src に書かれた sha256 トークンをすべて拾う
  const declared = [...scriptSrc.matchAll(SHA256_TOKEN_RE)].map((m) => m[1]);
  // 実際のインライン script から計算したハッシュをすべて求める
  const actual = inlineBodies.map(sha256Base64);

  // --- 規則 A: 宣言されたトークンの集合と、実際のハッシュの集合が過不足なく一致すること ---
  // 宣言側にあって実物が無いトークン（script を消したのに残っている／値が古い）
  const staleTokens = declared.filter((d) => !actual.includes(d));
  // 実物にあって宣言が無いハッシュ（script を足した／編集した）
  const missingTokens = actual.filter((a) => !declared.includes(a));

  // どちらか一方でもあれば、そのページの script はブラウザに実行を拒否される
  if (staleTokens.length > 0 || missingTokens.length > 0) {
    // 何が起きているかと、そのまま貼り替えられる値を並べて出す
    problems.push(
      `${fileName}: CSP の sha256 が実行対象のインライン script と一致しません。` +
        " このままだとブラウザが script の実行を拒否し、そのページの JavaScript が動かなくなります。\n" +
        `  実行対象のインライン script: ${inlineBodies.length} 個\n` +
        `  script-src の sha256 トークン: ${declared.length} 個\n` +
        (staleTokens.length > 0
          ? `  対応する script が無いトークン（削除する）:\n${staleTokens.map((t) => `    'sha256-${t}'`).join("\n")}\n`
          : "") +
        (missingTokens.length > 0
          ? `  宣言が足りない script のハッシュ（追加する）:\n${missingTokens.map((t) => `    'sha256-${t}'`).join("\n")}\n`
          : "") +
        `  対応: ${fileName} の CSP meta 内 script-src の sha256 トークンを上の内容へ合わせてください。`,
    );
  }

  // --- 規則 B: script を 1 つも持たないページは 'none'（最小権限）---
  // インラインも外部も無いのに 'none' でなければ、宣言が実態より緩い
  if (inlineBodies.length === 0 && externalCount === 0 && !scriptSrc.includes("'none'")) {
    problems.push(
      `${fileName}: script を 1 つも持たないので script-src は 'none' が最小権限です。` +
        ` 現在の宣言: ${scriptSrc}`,
    );
  }
}

// 検査対象のページをリポジトリルートから導出する
const pages = await findPages();

// 1 枚も見つからないのは前提が崩れている（＝「対象ゼロなので違反ゼロ」で緑になる状態）
if (pages.length === 0) {
  console.error("CSP の検査に失敗しました:\n");
  console.error("- リポジトリルートに HTML ファイルが 1 つも見つかりません。\n");
  process.exit(1);
}

// 対象ページを順に検査する
for (const page of pages) {
  await checkPage(page);
}

// 1 件でも問題があれば、内容を標準エラーへ出して終了コード 1 で落とす（CI を赤にする）
if (problems.length > 0) {
  console.error("CSP の検査に失敗しました:\n");
  // 見つかった問題を 1 件ずつ列挙する
  problems.forEach((p) => console.error(`- ${p}\n`));
  // 終了コードを 1 にして呼び出し元（CI）へ失敗を伝える
  process.exit(1);
}

// ここまで来たら問題なし。**何を確かめたのかだけ**を出す
// （「CSP OK」とだけ書くと、この検査が見ていない 'unsafe-eval' や許可ホストの追加まで
//   保証したように読めてしまうため、範囲を明示する）
console.log(
  `CSP sha256 OK: ${pages.join(" / ")} の実効ディレクティブの sha256 は、実行対象のインライン script と過不足なく一致しています。`,
);
