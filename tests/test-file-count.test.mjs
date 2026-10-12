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
const lib = require("../scripts/lib/test-file-count.cjs");
const { splitPath, isTestSourceFile, inspectTestFiles } = lib;
const { TEST_CONVENTIONS, UNCOUNTABLE_MESSAGES, UNCOUNTABLE_TRUNCATED, UNCOUNTABLE_SHAPE } = lib;

// ツリー応答を組み立てる小さなヘルパー（パスの配列を blob のリストにする）
function tree(paths, extra = {}) {
  return { truncated: false, tree: paths.map((path) => ({ type: "blob", path })), ...extra };
}
// 数えた件数だけを取り出す（数えられなかったときは null）
function count(paths, extra = {}) {
  return inspectTestFiles(tree(paths, extra)).count;
}

describe("テストファイルの数え方", () => {
  it("言語ごとの命名規約を数える", () => {
    const paths = [
      "tests/ticket-status.test.ts", // JS/TS: *.test.*
      "e2e/auth.spec.ts", // JS/TS: *.spec.*
      "src/__tests__/Button.tsx", // Jest: __tests__/ 配下
      "tests/test_planner.py", // Python: test_*
      "internal/sum_test.go", // Go: *_test.*
      "test/guard_test.sh", // Bash: *_test.*
      "spec/models/user_spec.rb", // Ruby: *_spec.rb
      "src/test/java/com/example/BatchConfigLoaderTest.java", // Java: *Test.*
      "tests/App.Tests/IncidentsControllerTests.cs", // C#: *Tests.*
    ];
    assert.equal(count(paths), paths.length); // すべて数える
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
      "src/__tests__/__snapshots__/Button.tsx.snap", // Jest のスナップショット
    ];
    assert.equal(count(paths), 0); // 1 つも数えない
  });

  it("規約は「名前の形 × その規約が通用する拡張子」で判定する", () => {
    // 名前の形だけで見ると、その言語でテストを意味しない綴りまで数えてしまう。
    // `db/test_data.sql` は pytest の収集対象ではないし、`Test.yml` はワークフロー
    assert.equal(count(["db/test_data.sql", ".github/workflows/Test.yml", "fixtures/data.test.json"]), 0);
    // 逆に、規約が通用する拡張子なら数える（Python の test_ 接頭辞は pytest が既定で収集する形）
    assert.equal(count(["scripts/test_helper.py"]), 1);
  });

  it("`Tests?` の規約は大文字の T を要求し、拡張子の大小には影響されない", () => {
    // 小文字まで許すと `latest.js` / `greatest.py` / `protest.rb` が「テスト」になる
    assert.equal(count(["src/latest.js", "src/greatest.py", "src/protest.rb"]), 0);
    // 拡張子は別で（小文字に正規化して）見るので、大文字の拡張子でも数える
    assert.equal(count(["src/FooTest.java", "src/BarTest.JAVA"]), 2);
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
    assert.equal(inspectTestFiles(response).count, 1);
  });

  it("ツリーが切り詰められていたら数えず、理由を返す", () => {
    // GitHub は大きなリポジトリで truncated: true を立てて一部だけ返す。そのまま数えると
    // 実際より少ない件数を「テスト N 件」として出し、画面からは正しい値と区別できない
    const result = inspectTestFiles(tree(["tests/a.test.ts"], { truncated: true }));
    assert.deepEqual(result, { count: null, reason: UNCOUNTABLE_TRUNCATED });
  });

  it("想定した形でない応答は数えず、切り詰めとは別の理由を返す", () => {
    // **理由を分けるのは、呼び出し側が事実と違う案内を出さないため。** 応答の形が変わっただけ
    // なのに「リポジトリが大きい」と言われると、運用者は存在しない巨大リポジトリを探しに行く
    for (const bad of [null, undefined, "", 42, {}, { tree: "nope" }]) {
      assert.deepEqual(inspectTestFiles(bad), { count: null, reason: UNCOUNTABLE_SHAPE }, `${JSON.stringify(bad)}`);
    }
  });

  it("理由には必ず運用者向けの文言がある（足し忘れを落とす）", () => {
    // 文言が無いと呼び出し側が undefined をそのままログへ出す
    for (const reason of [UNCOUNTABLE_TRUNCATED, UNCOUNTABLE_SHAPE]) {
      assert.equal(typeof UNCOUNTABLE_MESSAGES[reason], "string", `${reason} の文言が無い`);
      assert.ok(UNCOUNTABLE_MESSAGES[reason].length > 0, `${reason} の文言が空`);
    }
    // 表に余計なキーが無いこと（使われない文言＝どの経路からも出ない死に文言）
    assert.deepEqual(Object.keys(UNCOUNTABLE_MESSAGES).sort(), [UNCOUNTABLE_SHAPE, UNCOUNTABLE_TRUNCATED].sort());
  });

  it("規約の表は名前の形と拡張子を必ず対で持つ（片方だけの規約を作らせない）", () => {
    // 拡張子を空にすると、その規約は何にも当たらない（黙って効かなくなる）。
    // 判定を書き忘れた規約も同じく無言で死ぬので、表の形そのものを固定する
    assert.ok(TEST_CONVENTIONS.length > 0, "規約が 1 つも無い");
    for (const c of TEST_CONVENTIONS) {
      assert.ok(typeof c.label === "string" && c.label.length > 0, "規約に説明が無い");
      assert.ok(Array.isArray(c.extensions) && c.extensions.length > 0, `${c.label}: 拡張子が空`);
      assert.equal(typeof c.matches, "function", `${c.label}: 名前の判定が無い`);
      // 拡張子は小文字で書く（splitPath が小文字へそろえてから突き合わせるため）
      for (const ext of c.extensions) assert.equal(ext, ext.toLowerCase(), `${c.label}: ${ext} が小文字でない`);
    }
  });

  it("パスの分解は境界で壊れない", () => {
    assert.deepEqual(splitPath("a/b/c.test.TS"), { dir: "a/b", stem: "c.test", ext: "ts" }); // 拡張子は小文字へ
    assert.deepEqual(splitPath("Makefile"), { dir: "", stem: "Makefile", ext: "" }); // 拡張子なし
    assert.deepEqual(splitPath(".gitignore"), { dir: "", stem: ".gitignore", ext: "" }); // 先頭のドットは拡張子ではない
    assert.deepEqual(splitPath("a.b/c"), { dir: "a.b", stem: "c", ext: "" }); // ディレクトリ名のドットに引きずられない
    assert.equal(isTestSourceFile(""), false); // 空文字は数えない
    assert.equal(isTestSourceFile(undefined), false); // 文字列でなくても落ちない
  });

  it("ワークフローはこの判定を require して使っている（配線の確認）", () => {
    // **直書きへ戻す変更を落とす。** `script:` ブロックへ数え方を書き戻すと `node --test` から
    // 呼べなくなり、このファイルの検査がすべて空振りになる（`ci-verdict.cjs` と同じ理由）
    const workflow = readFileSync(new URL("../.github/workflows/update-portfolio-data.yml", import.meta.url), "utf8");
    assert.ok(workflow.includes("scripts/lib/test-file-count.cjs"), "ワークフローが判定モジュールを読み込んでいない");
    assert.ok(workflow.includes("inspectTestFiles("), "ワークフローが inspectTestFiles を呼んでいない");
    // 理由の文言もモジュール側が持つ（呼び出し側で書くと言い回しが割れる）
    assert.ok(workflow.includes("UNCOUNTABLE_MESSAGES["), "ワークフローが理由の文言表を使っていない");
    // **ツリーは確定した先頭コミットで引く。** ブランチ名で引くと getTree の時点で参照し直すので、
    // 直前に別のコミットが入ると「最終 <古い日付>」と「テスト <新しい件数>」が同じカードに並ぶ
    assert.ok(workflow.includes("tree_sha: sha || branch"), "ツリーを先頭コミットの sha で引いていない");
  });
});
