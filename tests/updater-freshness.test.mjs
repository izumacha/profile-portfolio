// `update-portfolio-data.yml` の鮮度チェック（`check_data_freshness`）の挙動を固定するテスト。
//
// **なぜこれが要るか。** この関数は「データが届かなくなったこと」を知らせる唯一の検知で、
// PR 作成が塞がっている構成ではここだけが赤を出す。ところが以前は PR 作成の失敗が
// その手前で `exit 1` していたため**一度も到達せず**（CLAUDE.md §3）、しかも YAML の中の
// シェルなので**テストも 1 つも無かった**。比較の向きを逆にする・ミリ秒を落とす処理を
// 消すといった変更が入っても、何も落ちないまま検知だけが静かに死ぬ。
//
// YAML から関数本体を切り出して `bash` で実際に動かす。切り出せなかったときは
// 「違反ゼロ」ではなく前提が崩れた状態なので落とす（fail-closed）。
import { describe, it } from "node:test"; // Node 同梱のテストランナー
import assert from "node:assert/strict"; // Node 同梱の表明（厳密比較）
import { readFileSync, mkdtempSync, rmSync } from "node:fs"; // ワークフローの読み取りと作業場の用意・片付け
import { spawnSync } from "node:child_process"; // bash を起動して関数を実際に動かす
import { tmpdir } from "node:os"; // 一時ディレクトリの置き場
import { join } from "node:path"; // パスの組み立て

// 検査対象のワークフローを読む
const source = readFileSync(new URL("../.github/workflows/update-portfolio-data.yml", import.meta.url), "utf8");

// 関数の本体（`          名前() {` から同じ字下げの `          }` まで）を切り出す
function extractFunction(name) {
  const head = `          ${name}() {`; // 関数の始まり（run: ブロック内の字下げを含む）
  const start = source.indexOf(head); // 始まりの位置
  if (start === -1) return null; // 見つからなければ切り出せない
  const tail = "\n          }\n"; // 同じ字下げの閉じ括弧
  const end = source.indexOf(tail, start); // 終わりの位置
  if (end === -1) return null; // 閉じ括弧が見つからなければ切り出せない
  return source.slice(start, end + tail.length); // 本体を返す
}

const fnSource = extractFunction("check_data_freshness"); // 鮮度チェックの本体
const hoursMatch = source.match(/^\s*STALE_DATA_HOURS=(\d+)$/m); // しきい値（時間）
const STALE_HOURS = hoursMatch ? Number(hoursMatch[1]) : null; // 数値にしておく

// jq の stderr を置く作業場。**呼び出しごとに作らず 1 つを使い回し、終了時に消す**
// （毎回 mkdtemp すると手元では実行回数ぶん一時ディレクトリが溜まる。CLAUDE.md §8）
const workDir = mkdtempSync(join(tmpdir(), "updater-freshness-")); // 作業場を 1 つ用意する
process.on("exit", () => {
  // 後片付け。消せなくてもテストの結果は変えない（握り潰すのは片付けの失敗だけ）
  try {
    rmSync(workDir, { recursive: true, force: true }); // 作業場をまるごと消す
  } catch {
    // 片付けに失敗しても検査結果には影響しないので何もしない
  }
});

// 指定した generated_at で関数を 1 回動かし、終了コードと注釈を返す。
// `scheduled` は本番の IS_SCHEDULED_RUN（定期実行か）。**既定は true**（＝本体を通す）で、
// 既定を false にすると既存の検査すべてが門番で素通りして検出網が空回りする
function runFreshness(generatedAt, { scheduled = true } = {}) {
  const script = [
    "set -euo pipefail", // 本番のステップと同じ設定で動かす
    `IS_SCHEDULED_RUN=${JSON.stringify(String(scheduled))}`, // 本番は env で渡る門番の判定材料
    "BASE_BRANCH=main", // 注釈に埋め込まれるだけの値
    "DATA_FILE=data/portfolio.json", // 同上
    `stale_err=${JSON.stringify(join(workDir, "stale.err"))}`, // jq の stderr の退避先（使い回す）
    ': > "$stale_err"', // 空ファイルとして用意する
    "escape_annotation() { cat; }", // 本番は sed/tr で無害化するが、挙動の検査には素通しで足りる
    "log() { :; }", // 進捗ログは捨てる
    `MERGED_GENERATED_AT=${JSON.stringify(generatedAt)}`, // 検査したい値
    `STALE_DATA_HOURS=${STALE_HOURS}`, // 切り出したしきい値をそのまま使う
    fnSource, // 切り出した関数本体
    'check_data_freshness "案内文のしるし"', // 経路ごとの案内文が出ることも見る
  ].join("\n");
  const result = spawnSync("bash", ["-c", script], { encoding: "utf8" }); // 実際に動かす
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// いまから指定時間だけ過去の ISO 8601（本番と同じくミリ秒付き）を作る
function hoursAgo(h) {
  return new Date(Date.now() - h * 3600 * 1000).toISOString(); // toISOString はミリ秒を含む
}

describe("updater の鮮度チェック", () => {
  it("検査が空回りしていない（前提の確認）", () => {
    // 切り出せていない・しきい値が読めていないのは「全部通った」ではなく「何も見ていない」
    assert.ok(fnSource, "check_data_freshness を切り出せない（関数の形を変えたらこの切り出しも直す）");
    assert.ok(Number.isInteger(STALE_HOURS) && STALE_HOURS > 0, "STALE_DATA_HOURS を読み取れない");
    // bash と jq が無いと何も検査できない（本番のステップも同じものを要求する）
    assert.equal(spawnSync("bash", ["-c", "command -v jq >/dev/null"]).status, 0, "jq が必要です（このテストはワークフローと同じ jq / bash を使います）");
  });

  it("既知の塞がり方では赤で止めず、鮮度チェックを通してから緑で終える（配線の確認）", () => {
    // **これが崩れると「毎日必ず赤」に戻る。** PAT が無い構成では GitHub が PR 作成を
    // 拒否し、所有者が設定を変えるまで毎日同じ失敗になる。そこを exit 1 にすると赤が
    // 合図として機能しなくなり（実測で 2 か月以上誰にも拾われなかった）、しかもその
    // exit 1 がこの鮮度チェックより手前にあるため**検知が一度も走らない**。
    // 2 つの枝を 1 つの `::error::` へ「整理」し直す変更を落とすため、順序を見る。
    const branch = source.indexOf('if [ "$HAS_DEPLOY_TOKEN" != "true" ]; then');
    assert.notEqual(branch, -1, "PAT の有無で分ける枝が見つからない");
    const after = source.slice(branch); // その枝から後ろだけを見る
    const warn = after.indexOf("::warning::"); // 原因と対処を警告で出す
    const check = after.indexOf("check_data_freshness "); // 鮮度チェックを通す
    const green = after.indexOf("exit 0"); // 緑で終える
    const red = after.indexOf("exit 1"); // 赤で止める（この枝より後ろの別経路のもの）
    assert.ok(warn > -1 && check > -1 && green > -1, `警告・鮮度チェック・exit 0 のいずれかが無い: ${JSON.stringify({ warn, check, green })}`);
    assert.ok(warn < check && check < green, "警告 → 鮮度チェック → exit 0 の順になっていない");
    assert.ok(green < red, "この枝が exit 1 で止まっている（赤が毎日出る状態に戻っている）");
  });

  it("原因が分かっている状態は警告へ落とさず赤のまま（指示が通知で届くこと）", () => {
    // base 付け替えの診断（base_mismatch_note）は、唯一効く指示を持っている。
    // これを警告の枝より**後ろ**へ移すと、PAT が無い構成ではそちらに吸い込まれて
    // 緑の run の注釈にしか載らず、スケジュール実行では誰にも届かない
    const diagnosed = source.indexOf('if [ -n "$base_mismatch_note" ]; then');
    const unknown = source.indexOf('if [ "$HAS_DEPLOY_TOKEN" != "true" ]; then');
    assert.notEqual(diagnosed, -1, "base 付け違いを赤で止める枝が無い");
    assert.notEqual(unknown, -1, "PAT の有無で分ける枝が無い");
    assert.ok(diagnosed < unknown, "診断済みの枝が警告の枝より後ろにある（指示が通知で届かなくなる）");
  });

  it("鮮度チェックは 2 つ以上の経路から呼ばれている", () => {
    // 片方の経路からしか呼ばれていないと、もう片方では検知が走らない
    // （以前はまさに「手配が成功した経路」からしか到達しなかった）。
    // **コメント中の言及は数えない** — このワークフローは経緯を長いコメントで残す慣習が
    // あるので、`# 以前は check_data_freshness "…" をここで呼んでいた` のような 1 行を
    // 残しつつ実際の呼び出しを削ると、件数だけ保たれて検出網が空回りする
    const calls = source
      .split("\n")
      .map((line) => line.trim()) // 字下げを落として行頭を見る
      .filter((line) => !line.startsWith("#")) // コメント行は数えない
      .filter((line) => line.includes('check_data_freshness "')); // 引数付きの呼び出しだけ
    assert.equal(calls.length, 2, `呼び出しが ${calls.length} 箇所（2 箇所であるべき）`);
  });

  it("手配が成功した経路の呼び出しは即時マージの日を除いている（誤検知の防止）", () => {
    // **このゲートを外すと false red になる。** 停止が解消して初めて即時マージできた日は、
    // MERGED_GENERATED_AT が停止期間中の古い値のままなので、すべて成功しているのに赤になり、
    // しかも「必須チェックが失敗し続けている」と事実と違うことを言う。
    // 関数化で「どちらの経路でも呼ぶ」形になった分、このゲートは「簡素化」の対象に見えるので、
    // 呼び出しが必ずこの条件の直下にあることを形で固定する
    assert.ok(
      source.includes('if [ "$merge_mode" != "immediate" ]; then\n              check_data_freshness "'),
      "末尾の呼び出しが `merge_mode != immediate` の直下に無い（即時マージの日に false red になる）",
    );
  });

  it("定期実行は意図的に外してある（前提の確認）", () => {
    // **この検査が落ちたら、落ちたこと自体が目的を果たしている。** 定期実行を再開するなら
    // それは「毎日動かしても人の操作なしでは取り込まれない」構成へ戻す判断なので、
    // ここと CLAUDE.md §3 を同じ変更セットで更新してレビューに載せること（下の鮮度の
    // 検知は github.event_name から導いているので、`schedule:` を足せば自動で再武装する）。
    const triggers = source.slice(source.indexOf("\non:"), source.indexOf("\npermissions:")); // on: ブロックだけを見る
    assert.notEqual(triggers, "", "on: ブロックを切り出せない");
    // **行頭の綴りで見るので、まずブロック形式であることを要求する。** `on: { schedule: [...] }`
    // のようにフロー形式で書かれると、行頭が `on: {` になって下の走査がまるごと外れ、
    // 日次実行を戻しても緑のまま通る（実測）。YAML パーサは依存が増えるので入れず、
    // 「走査が成り立つ形で書く」ことを条件にして fail-closed にする
    assert.ok(!/[{[]/.test(triggers), "on: をフロー形式で書くと下の走査が外れる（ブロック形式で書くこと）");
    const declarations = triggers
      .split("\n")
      .map((line) => line.trim()) // 字下げを落として行頭を見る
      .filter((line) => !line.startsWith("#")); // 経緯を書いたコメントは数えない（下記）
    // **コメントを除去してから見るのが要点。** このワークフローは経緯を長いコメントで残す
    // 慣習があり、今回の変更で `on:` のコメントは手動実行の話で埋まった。生のテキストを
    // `includes` で見ると、`workflow_dispatch:` の行を消してコメントに言及を残すだけで
    // 緑のまま通り、**トリガーが 0 件＝起動不能なワークフロー**を検知できない（実測）
    assert.deepEqual(
      declarations.filter((line) => line.startsWith("schedule:") || line.startsWith("- cron:")),
      [],
      "定期実行が宣言されている（意図的に止めてある前提が崩れた）",
    );
    assert.ok(
      declarations.some((line) => line.startsWith("workflow_dispatch:")),
      "手動実行の口が無い（止めたうえに動かせなくなっている）",
    );
  });

  it("門番の判定材料がイベント名から導かれている（検知が永久に閉じるのを防ぐ）", () => {
    // 式を「決して true にならないもの」（`'workflow_dispatch'` との比較や固定の false）へ
    // 書き換えると、`schedule:` を足し直しても検知が二度と鳴らない。しかも PR 作成が
    // 塞がっている構成では警告を出して緑で終わるので、**全部緑のまま**データ停止だけが
    // 見えなくなる。env の 1 行を落とす形は `set -u` が unbound variable で止めるので
    // 静かには壊れない（本番のコメントに実測を記録済み）が、こちらは静かに壊れる
    assert.ok(
      source.includes("IS_SCHEDULED_RUN: ${{ github.event_name == 'schedule' }}"),
      "IS_SCHEDULED_RUN が github.event_name == 'schedule' から導かれていない",
    );
  });

  it("定期実行でなければ、どれだけ古くても何も言わずに緑で通す", () => {
    // 手動実行は「いま更新したい」という操作なので、押した時点のデータは常に閾値より古い。
    // ここを赤にすると**正しく動いている手動実行が必ず赤**になり、「赤が合図として
    // 機能しない」状態を向きを変えて作り直すだけになる
    const r = runFreshness(hoursAgo(STALE_HOURS * 10), { scheduled: false }); // 遥かに古い値
    assert.equal(r.status, 0, `赤で止まっている: ${r.stdout}${r.stderr}`); // 緑で終わる
    assert.equal(r.stdout, "", `注釈が出ている: ${r.stdout}`); // 何も言わない
  });

  it("定期実行でなければ、判定材料が無くても読めなくても緑で通す（門番が先にあること）", () => {
    // 門番を 3 つの枝より**後ろ**に置くと、手動実行でも「判定できない」側が赤を出す。
    // 監視する対象が無い状態では安全網の有無を問う意味自体が無いので、門番が先に来る
    for (const value of ["", "2026/10/11 とても古い"]) {
      const r = runFreshness(value, { scheduled: false });
      assert.equal(r.status, 0, `${JSON.stringify(value)} で赤になった: ${r.stdout}${r.stderr}`);
      assert.equal(r.stdout, "", `${JSON.stringify(value)} で注釈が出た: ${r.stdout}`);
    }
  });

  it("しきい値より新しければ緑で通す", () => {
    const r = runFreshness(hoursAgo(STALE_HOURS - 1)); // 上限の 1 時間手前
    assert.equal(r.status, 0); // 正常終了
    assert.ok(!r.stdout.includes("::error::"), `注釈が出ている: ${r.stdout}`); // 何も言わない
  });

  it("しきい値より古ければ赤で止め、経路ごとの案内文を添える", () => {
    const r = runFreshness(hoursAgo(STALE_HOURS + 1)); // 上限の 1 時間先
    assert.equal(r.status, 1); // 赤で終わる
    assert.ok(r.stdout.includes(`${STALE_HOURS} 時間以上更新されていません`), r.stdout); // 停止として報告する
    assert.ok(r.stdout.includes("案内文のしるし"), r.stdout); // 呼び出し側の案内文が載る
  });

  it("ミリ秒付きの値をそのまま判定できる（本番の generated_at の形）", () => {
    // 生成側は JavaScript の toISOString() なのでミリ秒が付く。小数部を落とす処理が
    // 消えると jq が解釈に失敗し、「停止」ではなく「判定できない」側へ倒れてしまう
    const withMs = hoursAgo(STALE_HOURS + 1);
    assert.ok(/\.\d+Z$/.test(withMs), "この検査はミリ秒付きの値で行う必要がある");
    const r = runFreshness(withMs);
    assert.ok(r.stdout.includes("時間以上更新されていません"), r.stdout); // 停止として読めている
    assert.ok(!r.stdout.includes("判定できませんでした"), r.stdout); // 解釈に失敗していない
  });

  it("判定材料が無ければ赤で止める（検知だけが無言で死ぬのを防ぐ）", () => {
    const r = runFreshness(""); // generated_at が渡ってこなかった場合
    assert.equal(r.status, 1); // 赤で終わる
    assert.ok(r.stdout.includes("generated_at を受け取れていない"), r.stdout);
  });

  it("日時として読めなければ赤で止める（安全網が外れた状態を緑にしない）", () => {
    const r = runFreshness("2026/10/11 とても古い"); // 手で編集された・書式が変わった場合
    assert.equal(r.status, 1); // 赤で終わる
    assert.ok(r.stdout.includes("鮮度を判定できませんでした"), r.stdout);
  });
});
