// プロジェクトカードに出す「テスト N 件」を決める判定。**この数え方の唯一の正本**。
//
// **なぜワークフローの中に書かないか。** `actions/github-script` の `script:` ブロックは
// `node --test` から呼べないので、数え方を間違えても何も落ちない。`ci-verdict.cjs` を
// 切り出したのと同じ理由で、判定だけをここへ出して単体テストで固定する
// （ワークフロー側は「GitHub API をどう叩くか」だけを持つ）。
//
// **数え方の方針: 多めより少なめに倒す。** この値は「いま本当にこれだけテストがある」という
// 自己証明として画面に出るので、**数え過ぎ（嘘）より数え落とし（控えめ）の方が安全**。
// 以前の実装は「`tests/` や `e2e/` の下にあるファイル」を数えており、実測で
// スナップショットの PNG 2 枚とヘルパーのモジュールまで「テスト」に含めていた
// （profile-portfolio で 8 件と出ていたが、実際のテストファイルは 5 件）。
// そこで**ファイル名の慣習**で判定し、さらに拡張子を許可リストで絞る。
//
// 実測（2026-10-12 時点の既定ブランチ）: helpdesk-hub 185 / incident-insight 67 /
// AI-Docker-Environment 7 / profile-portfolio 5。
// 数え落としの例も記録しておく: AI-Docker-Environment の `test/sec18_denylist_e2e.sh` は
// CI の e2e ジョブが実行する本物のテストだが、どの命名規約にも当たらないので数えない。

// テストファイルの命名規約。言語ごとの慣習をそのまま列挙する（増やすときはここだけ）
const TEST_NAME_RULES = [
  /\.(test|spec)\.[a-z0-9]+$/i, // JS / TS: foo.test.ts, foo.spec.ts
  /(^|\/)test_[^/]+$/i, // Python: test_foo.py
  /_test\.[a-z0-9]+$/i, // Go / Bash: foo_test.go, guard_test.sh
  /Tests?\.[a-z0-9]+$/, // Java / C#: FooTest.java, FooTests.cs（大文字の T を要求する）
];

// 「ソースコードの拡張子」の許可リスト。**知らない拡張子は数えない**（数え落とす側へ倒す）。
// これが無いと `Test.yml`（ワークフロー）や `data.test.json`（フィクスチャ）まで数える
const SOURCE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", // JavaScript / TypeScript
  "py", "rb", "pl", "lua", "php", // スクリプト言語
  "java", "kt", "kts", "scala", "cs", "vb", "fs", // JVM / .NET
  "go", "rs", "swift", "dart", "ex", "exs", "clj", // その他の言語
  "c", "cc", "cpp", "h", "hpp", "m", "mm", // C 系
  "sh", "bash", "zsh", // シェル
  "sql", // SQL
]);

/**
 * パスの拡張子（小文字）を取り出す。拡張子が無ければ空文字を返す。
 *
 * @param {string} path リポジトリルートからのパス
 * @returns {string} 小文字の拡張子（ドットを含まない）
 */
function extensionOf(path) {
  const base = path.split("/").pop() || ""; // 最後の / より後ろ＝ファイル名
  const dot = base.lastIndexOf("."); // 最後のドットの位置
  if (dot <= 0) return ""; // ドットが無い／先頭のみ（.gitignore 等）は拡張子なし扱い
  return base.slice(dot + 1).toLowerCase(); // ドットの後ろを小文字にして返す
}

/**
 * そのパスを「テストファイル」として数えるかを判定する。
 *
 * @param {string} path リポジトリルートからのパス
 * @returns {boolean} 数えるなら true
 */
function isTestSourceFile(path) {
  if (typeof path !== "string" || path === "") return false; // 文字列でなければ数えない
  if (!SOURCE_EXTENSIONS.has(extensionOf(path))) return false; // 許可リスト外の拡張子は数えない
  return TEST_NAME_RULES.some((rule) => rule.test(path)); // 命名規約のどれかに当たれば数える
}

/**
 * Git ツリーの応答からテストファイル数を数える。
 *
 * **ツリーが切り詰められていたら `null` を返す。** GitHub の
 * `GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1` は、大きなリポジトリでは
 * `truncated: true` を立てて**一部だけ**返す。そのまま数えると実際より少ない値を
 * 「テスト N 件」として出してしまい、しかも画面からは正しい値と見分けが付かない。
 * 数えられないときは数えない（呼び出し側はバッジを出さない）。
 *
 * @param {{truncated?: boolean, tree?: Array<{type?: string, path?: string}>}} response getTree の data
 * @returns {number|null} テストファイル数。数えられないときは null
 */
function countTestFiles(response) {
  if (!response || typeof response !== "object") return null; // 応答が無ければ数えられない
  if (response.truncated === true) return null; // 一部しか返っていないので数えない
  if (!Array.isArray(response.tree)) return null; // 想定した形でなければ数えない
  // blob（ファイル）だけを対象に、上の判定に当たるものを数える
  return response.tree.filter((node) => node && node.type === "blob" && isTestSourceFile(node.path)).length;
}

// ワークフロー（github-script）とユニットテストの両方から使えるように公開する
module.exports = { TEST_NAME_RULES, SOURCE_EXTENSIONS, extensionOf, isTestSourceFile, countTestFiles };
