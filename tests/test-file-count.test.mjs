// `scripts/lib/test-file-count.cjs`（「テスト N 件」バッジの数え方）を固定するテスト。
//
// **なぜこれが要るか。** この値は画面に「自己証明」として出るので、数え過ぎると嘘になる。
// 以前の実装はワークフローの `script:` ブロックに直書きされていて `node --test` から呼べず、
// 実測でスナップショットの PNG まで「テスト」に数えていたのに何も落ちなかった
// （profile-portfolio で 8 件と出ていたが、実際のテストファイルは 5 件）。
import { describe, it } from "node:test"; // Node 同梱のテストランナー
import assert from "node:assert/strict"; // Node 同梱の表明（厳密比較）
import { readFileSync } from "node:fs"; // ワークフローの配線を読む
import { createRequire } from "node:module"; // CommonJS の判定モジュールを読み込む

const require = createRequire(import.meta.url); // ESM から CJS を require するための入口
const { extensionOf, isTestSourceFile, countTestFiles } = require("../scripts/lib/test-file-count.cjs");

// ツリー応答を組み立てる小さなヘルパー（パスの配列を blob のリストにする）
function tree(paths, extra = {}) {
  return { truncated: false, tree: paths.map((path) => ({ type: "blob", path })), ...extra };
}

describe("テストファイルの数え方", () => {
  it("言語ごとの命名規約を数える", () => {
    const paths = [
      "tests/ticket-status.test.ts", // JS/TS: *.test.*
      "e2e/auth.spec.ts", // JS/TS: *.spec.*
      "tests/test_planner.py", // Python: test_*
      "internal/sum_test.go", // Go: *_test.*
      "test/guard_test.sh", // Bash: *_test.*
      "src/test/java/com/example/BatchConfigLoaderTest.java", // Java: *Test.*
      "tests/App.Tests/IncidentsControllerTests.cs", // C#: *Tests.*
    ];
    assert.equal(countTestFiles(tree(paths)), paths.length); // すべて数える
  });

  it("テスト置き場にあるだけのファイルは数えない（数え過ぎを避ける）", () => {
    // **以前の実装はここを数えていた。** ディレクトリで判定していたため、スナップショットの
    // PNG もヘルパーのモジュールも「テスト」に含まれ、実際より多い件数を出していた
    const paths = [
      "e2e/visual.spec.ts-snapshots/index-linux.png", // スナップショット画像
      "e2e/lib/tracked-pages.ts", // テストが使うヘルパー
      "tests/fixtures/sample.json", // フィクスチャ
      "tests/README.md", // 説明文
      "tests/App.Tests/packages.lock.json", // ロックファイル
    ];
    assert.equal(countTestFiles(tree(paths)), 0); // 1 つも数えない
  });

  it("許可リストに無い拡張子は、名前が当たっても数えない", () => {
    // 拡張子で絞らないと `Test.yml`（ワークフロー）や `data.test.json`（フィクスチャ）が
    // 命名規約に当たってしまう。知らない拡張子は数えない側へ倒す
    assert.equal(countTestFiles(tree([".github/workflows/Test.yml", "fixtures/data.test.json", "e2e/a_test.png"])), 0);
    assert.equal(isTestSourceFile("tests/a.test.ts"), true); // 許可リスト内なら数える
  });

  it("`Tests?` の規約は大文字の T を要求する（英単語の巻き込みを防ぐ）", () => {
    // 小文字まで許すと `latest.js` / `greatest.py` / `protest.rb` が「テスト」になる
    assert.equal(countTestFiles(tree(["src/latest.js", "src/greatest.py", "src/protest.rb"])), 0);
    assert.equal(isTestSourceFile("src/FooTest.java"), true); // 大文字で始まる規約は数える
  });

  it("blob 以外（ディレクトリ・サブモジュール）は数えない", () => {
    const response = {
      truncated: false,
      tree: [
        { type: "tree", path: "tests/a.test.ts" }, // ディレクトリ（ありえないが形として）
        { type: "commit", path: "vendor/sub.test.ts" }, // サブモジュール
        { type: "blob", path: "tests/b.test.ts" }, // これだけが対象
      ],
    };
    assert.equal(countTestFiles(response), 1);
  });

  it("ツリーが切り詰められていたら数えない（少ない値を事実として出さない）", () => {
    // GitHub は大きなリポジトリで truncated: true を立てて一部だけ返す。そのまま数えると
    // 実際より少ない件数を「テスト N 件」として出し、画面からは正しい値と区別できない
    assert.equal(countTestFiles(tree(["tests/a.test.ts"], { truncated: true })), null);
  });

  it("想定した形でない応答は数えない（fail-closed）", () => {
    for (const bad of [null, undefined, "", 42, {}, { tree: "nope" }]) {
      assert.equal(countTestFiles(bad), null, `${JSON.stringify(bad)} で null を返していない`);
    }
  });

  it("拡張子の取り出しは境界で壊れない", () => {
    assert.equal(extensionOf("a/b/c.test.TS"), "ts"); // 小文字にそろえる
    assert.equal(extensionOf("Makefile"), ""); // 拡張子なし
    assert.equal(extensionOf(".gitignore"), ""); // 先頭のドットは拡張子ではない
    assert.equal(extensionOf("a.b/c"), ""); // ディレクトリ名のドットに引きずられない
  });

  it("ワークフローはこの判定を require して使っている（配線の確認）", () => {
    // **直書きへ戻す変更を落とす。** `script:` ブロックへ数え方を書き戻すと `node --test` から
    // 呼べなくなり、このファイルの検査がすべて空振りになる（`ci-verdict.cjs` と同じ理由）
    const workflow = readFileSync(new URL("../.github/workflows/update-portfolio-data.yml", import.meta.url), "utf8");
    assert.ok(workflow.includes("scripts/lib/test-file-count.cjs"), "ワークフローが判定モジュールを読み込んでいない");
    assert.ok(workflow.includes("countTestFiles("), "ワークフローが countTestFiles を呼んでいない");
  });
});
