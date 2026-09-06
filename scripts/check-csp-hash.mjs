/**
 * CSP の script-src に書いた sha256 ハッシュが、実際のインライン script と一致するかを検査する。
 *
 * なぜ要るのか:
 * index.html は GitHub Pages が HTTP ヘッダを付けられないため、CSP を <meta> で配信している。
 * script-src は 'unsafe-inline' を使わず、body 末尾のインライン script 本文の
 * base64(SHA-256(...)) を 1 つだけ許可する形になっている。
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
 * 何を見るか（すべて fail-closed。前提が崩れたら「違反ゼロ＝緑」にせず落とす）:
 *   1. index.html の実行対象インライン script がちょうど 1 つであること
 *   2. その本文のハッシュが script-src の sha256 トークンと一致すること
 *   3. resume.html が script-src 'none' を宣言し、実際にインライン script を持たないこと
 *
 * 3 を入れるのは、resume.html 側の「このページに script は無い」という前提が黙って
 * 崩れるのを防ぐため。script を足しても CSP が 'none' のままなら同じく実行拒否になる。
 *
 * 依存を増やさない（§9 サプライチェーン最小化）ため外部パッケージは使わず、Node 標準だけで組み立てる。
 */

// SHA-256 を計算するための Node 標準モジュール
import { createHash } from "node:crypto";
// HTML ファイルを読むための Node 標準モジュール（Promise 版）
import { readFile } from "node:fs/promises";
// このファイルの位置からリポジトリのルートを求めるために使う
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// このスクリプトが置かれている scripts/ の 1 つ上＝リポジトリのルート
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// 実行対象のインライン script を拾う正規表現。
// - `src=` を持つものは外部 script なので除外する（ハッシュの対象外）
// - `type="application/ld+json"` は構造化データで、ブラウザは実行しないため除外する
//   （CSP の script-src にも支配されない。index.html 冒頭のコメントに同じ説明がある）
const INLINE_SCRIPT_RE =
  /<script(?![^>]*\bsrc=)(?![^>]*ld\+json)[^>]*>([\s\S]*?)<\/script>/g;

// CSP の meta タグから content 属性の中身を取り出す正規表現
const CSP_META_RE =
  /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/;

// script-src ディレクティブに書かれた sha256 トークンを拾う正規表現
const SHA256_TOKEN_RE = /'sha256-([A-Za-z0-9+/=]+)'/g;

// 見つかった問題を溜める配列（1 件目で打ち切らず、まとめて報告する）
const problems = [];

/**
 * 文字列の SHA-256 を CSP のトークン形式（base64）で返す。
 *
 * ブラウザは「script 開始タグと終了タグの間の文字列」を UTF-8 のバイト列として
 * ハッシュするので、こちらも同じ範囲・同じ符号化で計算する。
 *
 * @param {string} text ハッシュ対象の script 本文
 * @returns {string} base64 エンコードした SHA-256 値
 */
function sha256Base64(text) {
  // UTF-8 のバイト列としてダイジェストを取り、base64 文字列にして返す
  return createHash("sha256").update(text, "utf8").digest("base64");
}

/**
 * HTML から CSP の script-src ディレクティブを取り出す。
 *
 * @param {string} html 対象ファイルの中身
 * @param {string} label エラーメッセージに出すファイル名
 * @returns {string | null} script-src の値（見つからなければ null）
 */
function readScriptSrc(html, label) {
  // CSP の meta タグを探す
  const meta = CSP_META_RE.exec(html);
  // meta ごと無ければ検査の前提が崩れているので落とす（fail-closed）
  if (!meta) {
    problems.push(`${label}: Content-Security-Policy の meta タグが見つかりません。`);
    return null;
  }
  // ディレクティブは ";" 区切りなので分割し、前後の空白を落とす
  const directives = meta[1].split(";").map((d) => d.trim());
  // "script-src " で始まるディレクティブを探す
  const scriptSrc = directives.find((d) => d.startsWith("script-src "));
  // script-src が無ければ default-src へフォールバックする挙動になり、意図が読めないので落とす
  if (!scriptSrc) {
    problems.push(`${label}: CSP に script-src ディレクティブがありません。`);
    return null;
  }
  // 見つかったディレクティブをそのまま返す
  return scriptSrc;
}

/**
 * index.html を検査する（インライン script はちょうど 1 つ／ハッシュが一致すること）。
 */
async function checkIndex() {
  // 対象ファイルのパスを組み立てる
  const path = join(REPO_ROOT, "index.html");
  // ファイルの中身を UTF-8 で読み込む
  const html = await readFile(path, "utf8");

  // 実行対象のインライン script をすべて拾う
  const scripts = [...html.matchAll(INLINE_SCRIPT_RE)].map((m) => m[1]);
  // ちょうど 1 つという前提が崩れたら落とす。
  // 2 つ以上に増やす場合は CSP へその分のハッシュを足したうえでこの検査も拡張すること
  if (scripts.length !== 1) {
    problems.push(
      `index.html: 実行対象のインライン script はちょうど 1 つである前提ですが ${scripts.length} 個見つかりました。` +
        " 増やす場合は CSP の script-src へ各 script 分の sha256 を追加し、この検査も複数対応へ広げてください。",
    );
    return;
  }

  // script-src ディレクティブを取り出す
  const scriptSrc = readScriptSrc(html, "index.html");
  // 取り出せなければ（理由は readScriptSrc が既に記録済み）ここで打ち切る
  if (!scriptSrc) return;

  // script-src に書かれた sha256 トークンをすべて拾う
  const declared = [...scriptSrc.matchAll(SHA256_TOKEN_RE)].map((m) => m[1]);
  // トークンもちょうど 1 つという前提（script が 1 つなので）
  if (declared.length !== 1) {
    problems.push(
      `index.html: script-src の sha256 トークンはちょうど 1 つである前提ですが ${declared.length} 個見つかりました。`,
    );
    return;
  }

  // 実際の script 本文から期待されるハッシュを計算する
  const actual = sha256Base64(scripts[0]);
  // 宣言されたハッシュと一致しなければ、その script はブラウザに実行を拒否される
  if (actual !== declared[0]) {
    problems.push(
      "index.html: CSP の sha256 がインライン script の中身と一致しません。" +
        " このままだとブラウザが script の実行を拒否し、ページの JavaScript が丸ごと動かなくなります。\n" +
        `  script-src の宣言値: sha256-${declared[0]}\n` +
        `  実際に必要な値      : sha256-${actual}\n` +
        "  対応: index.html の CSP meta 内の sha256 トークンを上の「実際に必要な値」へ置き換えてください。",
    );
  }
}

/**
 * resume.html を検査する（script-src 'none' と「script を持たない」ことが揃っていること）。
 */
async function checkResume() {
  // 対象ファイルのパスを組み立てる
  const path = join(REPO_ROOT, "resume.html");
  // ファイルの中身を UTF-8 で読み込む
  const html = await readFile(path, "utf8");

  // 実行対象のインライン script をすべて拾う
  const scripts = [...html.matchAll(INLINE_SCRIPT_RE)].map((m) => m[1]);
  // script-src ディレクティブを取り出す
  const scriptSrc = readScriptSrc(html, "resume.html");
  // 取り出せなければ（理由は readScriptSrc が既に記録済み）ここで打ち切る
  if (!scriptSrc) return;

  // 'none' を宣言しているかどうかを調べる
  const declaresNone = scriptSrc.includes("'none'");

  // script を持たないのに 'none' でない場合は、宣言が実態より緩い（最小権限に反する）
  if (scripts.length === 0 && !declaresNone) {
    problems.push(
      "resume.html: インライン script を 1 つも持たないので script-src は 'none' が最小権限です。" +
        ` 現在の宣言: ${scriptSrc}`,
    );
  }

  // script を持つのに 'none' のままだと、その script はブラウザに実行を拒否される
  if (scripts.length > 0 && declaresNone) {
    problems.push(
      `resume.html: インライン script が ${scripts.length} 個ありますが script-src は 'none' のままです。` +
        " このままではブラウザが実行を拒否します。index.html と同じ sha256 方式へ切り替えてください。",
    );
  }
}

// 2 ファイル分の検査を順に流す
await checkIndex();
await checkResume();

// 1 件でも問題があれば、内容を標準エラーへ出して終了コード 1 で落とす（CI を赤にする）
if (problems.length > 0) {
  console.error("CSP の検査に失敗しました:\n");
  // 見つかった問題を 1 件ずつ列挙する
  problems.forEach((p) => console.error(`- ${p}\n`));
  // 終了コードを 1 にして呼び出し元（CI）へ失敗を伝える
  process.exit(1);
}

// ここまで来たら問題なし。確認できた内容を 1 行だけ出す
console.log("CSP OK: index.html の sha256 はインライン script と一致し、resume.html は script-src 'none' です。");
