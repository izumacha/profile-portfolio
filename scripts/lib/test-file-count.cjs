// プロジェクトカードに出す「テスト N 件」を決める判定。**この数え方の唯一の正本**。
//
// **なぜワークフローの中に書かないか。** `actions/github-script` の `script:` ブロックは
// `node --test` から呼べないので、数え方を間違えても何も落ちない。`ci-verdict.cjs` を
// 切り出したのと同じ理由で、判定だけをここへ出して単体テストで固定する
// （ワークフロー側は「GitHub API をどう叩くか」だけを持つ）。
//
// **判定は「規約 × その規約が通用する拡張子」の対で持つ。** 名前の形だけで見ると
// `db/test_data.sql` のような別物を数えてしまい、拡張子だけで見ると何も絞れない。
// 以前の実装は「`tests/` や `e2e/` の下にあるファイル」を数えており、実測で
// スナップショットの PNG 2 枚とヘルパーのモジュールまで「テスト」に含めていた
// （profile-portfolio で 8 件と出ていたが、実際のテストファイルは 5 件）。
//
// **数え過ぎより数え落としへ倒す。** この値は「いま本当にこれだけテストがある」という
// 自己証明として画面に出るので、**数え過ぎ（嘘）より数え落とし（控えめ）の方が安全**。
// 規約に無い書き方は数えない。
//
// **ただし「0 件」だけは控えめで済まない。** 画面は 0 を「数えた結果 0 件」として出すので、
// 規約を 1 つも満たさないリポジトリでは「テストが無い」という**積極的に誤った主張**になる。
// **追跡対象（ワークフローの TARGETS）を増やすときは、そのリポジトリのテストが下の規約の
// どれかに当たるかを必ず手で確かめ、当たらなければ規約を足すこと。**（`ci-verdict.cjs` の
// `CI_NAME_RE` に同じ注意書きがあるのと同じ理由 —— 名前の規約は網羅できない。）
//
// 実測（2026-10-12 時点の既定ブランチ）: helpdesk-hub 185 / incident-insight 67 /
// AI-Docker-Environment 7 / profile-portfolio 5。
// 数え落としの例も記録しておく: AI-Docker-Environment の `test/sec18_denylist_e2e.sh` は
// CI の e2e ジョブが実行する本物のテストだが、どの規約にも当たらないので数えない。

// JavaScript / TypeScript 系の拡張子（複数の規約で共有する）
const JS_EXTENSIONS = ["ts", "tsx", "js", "jsx", "mjs", "cjs"];

// テストファイルの命名規約。**規約を足すのはここだけ**（名前の形と拡張子は必ず対で足す）
const TEST_CONVENTIONS = [
  {
    label: "JavaScript / TypeScript: foo.test.ts / foo.spec.ts",
    extensions: JS_EXTENSIONS, // JS/TS 系に限る（data.test.json のようなフィクスチャを除くため）
    matches: ({ stem }) => /\.(test|spec)$/i.test(stem), // 拡張子を除いた名前が .test / .spec で終わる
  },
  {
    label: "Jest: __tests__/ 配下",
    extensions: JS_EXTENSIONS, // 同上
    // `__tests__` は Jest が予約している名前で、中身はテストだけという慣習が強い。
    // 一般名の `tests/` を同じ扱いにしない（あちらは設定ファイルやフィクスチャも入る）
    matches: ({ dir }) => /(^|\/)__tests__(\/|$)/.test(dir),
  },
  {
    label: "Python: test_foo.py",
    extensions: ["py"], // pytest が既定で収集する形。他言語に同じ意味は無い
    matches: ({ stem }) => /^test_/.test(stem), // 拡張子を除いた名前が test_ で始まる
  },
  {
    label: "Go / シェル / Python: foo_test.go",
    extensions: ["go", "py", "sh", "bash", "zsh"], // この接尾辞をテストに使う言語だけ
    matches: ({ stem }) => /_test$/i.test(stem), // 拡張子を除いた名前が _test で終わる
  },
  {
    label: "Ruby: foo_spec.rb",
    extensions: ["rb"], // RSpec の規約
    matches: ({ stem }) => /_spec$/i.test(stem), // 拡張子を除いた名前が _spec で終わる
  },
  {
    label: "Java / C# 系: FooTest.java / FooTests.cs",
    extensions: ["java", "kt", "kts", "scala", "cs", "vb", "fs"], // クラス名＝ファイル名の文化
    // **大文字の T を要求する**（小文字まで許すと latest.js / greatest.py / protest.rb を巻き込む）。
    // 拡張子は別で見るので、ここは拡張子の大小に影響されない
    matches: ({ stem }) => /Tests?$/.test(stem),
  },
];

/**
 * パスを「ディレクトリ・拡張子を除いた名前・拡張子（小文字）」に分解する。
 *
 * @param {string} path リポジトリルートからのパス
 * @returns {{dir: string, stem: string, ext: string}} 分解した結果
 */
function splitPath(path) {
  const slash = path.lastIndexOf("/"); // 最後の / の位置
  const dir = slash === -1 ? "" : path.slice(0, slash); // ディレクトリ部分（無ければ空）
  const base = slash === -1 ? path : path.slice(slash + 1); // ファイル名
  const dot = base.lastIndexOf("."); // 最後のドットの位置
  if (dot <= 0) return { dir, stem: base, ext: "" }; // ドット無し／先頭のみ（.gitignore 等）
  return { dir, stem: base.slice(0, dot), ext: base.slice(dot + 1).toLowerCase() }; // 拡張子は小文字へ
}

/**
 * そのパスを「テストファイル」として数えるかを判定する。
 *
 * @param {string} path リポジトリルートからのパス
 * @returns {boolean} 数えるなら true
 */
function isTestSourceFile(path) {
  if (typeof path !== "string" || path === "") return false; // 文字列でなければ数えない
  const parts = splitPath(path); // ディレクトリ・名前・拡張子に分ける
  // 規約のどれかが「拡張子も名前も当たる」なら数える（拡張子だけ・名前だけでは数えない）
  return TEST_CONVENTIONS.some((c) => c.extensions.includes(parts.ext) && c.matches(parts));
}

// 数えられなかった理由。**文言は下の表が持つ**（呼び出し側で書くと言い回しが割れる）
const UNCOUNTABLE_TRUNCATED = "truncated"; // ツリーが切り詰められていた
const UNCOUNTABLE_SHAPE = "unexpected-shape"; // 応答が想定した形ではなかった

// 理由 → 運用者へ出す日本語。**理由を足したらここも足す**（足し忘れは undefined になるので
// 呼び出し側がそのまま出してしまう。単体テストが網羅を見張る）
const UNCOUNTABLE_MESSAGES = {
  [UNCOUNTABLE_TRUNCATED]: "ツリーが切り詰められている（リポジトリが大きい）ためテスト数を数えられません",
  [UNCOUNTABLE_SHAPE]: "ツリーの応答が想定した形ではないためテスト数を数えられません（GitHub API の変更を疑ってください）",
};

/**
 * Git ツリーの応答からテストファイル数を数える。
 *
 * **数えられないときは件数ではなく理由を返す。** GitHub の
 * `GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1` は、大きなリポジトリでは
 * `truncated: true` を立てて**一部だけ**返す。そのまま数えると実際より少ない値を
 * 「テスト N 件」として出してしまい、しかも画面からは正しい値と見分けが付かない。
 * 応答の形が変わった場合も同じく数えない。**理由を分けて返すのは、呼び出し側が
 * 「大きすぎる」と「形が変わった」を取り違えて事実と違う案内を出さないため。**
 *
 * @param {{truncated?: boolean, tree?: Array<{type?: string, path?: string}>}} response getTree の data
 * @returns {{count: number|null, reason: string|null}} 数えられたら count、無理なら reason
 */
function inspectTestFiles(response) {
  if (!response || typeof response !== "object") return { count: null, reason: UNCOUNTABLE_SHAPE }; // 応答が無い
  if (response.truncated === true) return { count: null, reason: UNCOUNTABLE_TRUNCATED }; // 一部しか返っていない
  if (!Array.isArray(response.tree)) return { count: null, reason: UNCOUNTABLE_SHAPE }; // 形が違う
  // blob（ファイル）だけを対象に、上の判定に当たるものを数える
  const count = response.tree.filter((n) => n && n.type === "blob" && isTestSourceFile(n.path)).length;
  return { count, reason: null }; // 数えられた
}

// ワークフロー（github-script）とユニットテストの両方から使えるように公開する
module.exports = {
  TEST_CONVENTIONS,
  UNCOUNTABLE_TRUNCATED,
  UNCOUNTABLE_SHAPE,
  UNCOUNTABLE_MESSAGES,
  splitPath,
  isTestSourceFile,
  inspectTestFiles,
};
