"use strict";

// 追跡対象リポジトリの「CI の判定」を、ワークフロー実行の一覧から 1 つ決めるための純粋ロジック。
//
// **なぜワークフロー（.github/workflows/update-portfolio-data.yml）の中に書かないのか。**
// ここは `data/portfolio.json` の「Live self-proof」バッジが何を名乗るかを決めている場所で、
// 間違えるとサイトが事実と違うことを主張する。YAML の中のインライン script は
// `node --test` から呼べないので、**実装を変えても何も落ちない**（実際、以下の 3 つの欠陥は
// 2 か月以上そのまま出荷され、2026-10 時点の履歴 59 スナップショット＝236 リポジトリ観測の
// うち 92 件＝約 39% が誤ったバッジだった）。内訳と調べ方は CLAUDE.md §3 を参照。
// 判定だけをここへ出し、取得（API 呼び出し）は呼び出し側から注入してもらう形にすると、
// 3 つとも `tests/ci-verdict.test.mjs` が固定できる。
//
// **実測で分かっていた 3 つの誤り**（いずれも「CI は success だったのに別の値を出す」側。
// 誤りの件数と内訳は CLAUDE.md §3 の表が正本なので、ここには書かない）:
//   (1) CI を*追いかける*後続ワークフロー（`post-ci-verify.yml`。`workflow_run` で起動するので
//       必ず CI より後に作られる）が「created_at が最新の run を採る」規則で勝ち、その
//       conclusion（skipped や failure）を CI の判定として出していた。
//   (2) リポジトリ全体の run を `per_page: 30` で引いていたため、`schedule` で頻繁に走る
//       ワークフロー（sla-reminders 等）が 1 ページを埋め尽くし、ちょうど 1 件の `ci.yml` が
//       ページ外に落ちていた。
//   (3) updater 自身の `GITHUB_TOKEN` による push は GitHub の仕様で他のワークフローを
//       起動しないので、既定ブランチの先頭コミットには CI の run が 1 つも無い。
//       「先頭コミットの run だけを採る」規則だと判定なしになる。
//
// (1) は「run の event を見る」、(2) は「ワークフローごとに引く」、(3) は「判定が付いた
// コミットまで遡り、どのコミットの判定かを一緒に返す」で、どれも閾値ではなく形で閉じる。

// CI とみなすワークフロー名／ファイルパスの許可パターン（大文字小文字は無視）。
const CI_NAME_RE = /(\bci\b|build|test|lint|lighthouse|playwright|e2e|verify)/i;

// 明示的に除外するワークフロー（この updater 自身・デプロイ・Pages など、コードの検証ではないもの）。
const EXCLUDE_RE = /(update[\s_-]*portfolio|portfolio[\s_-]*data|update[\s_-]*snapshots|deploy|pages)/i;

// 「コードについての判定を持たない」結論。バッジに出さず、次のコミットへ遡る材料にする。
// skipped … パスフィルタ等でジョブが走っていない（合格でも不合格でもない）
// neutral … チェックが中立で終わった（同上）
const VERDICTLESS_CONCLUSIONS = new Set(["skipped", "neutral"]);

// 知らない結論に与える順位の目印。GitHub の conclusion には使われない綴りにしてある。
const UNKNOWN_STATUS = "(unknown)";

// 悪い順に並べた優先順位。複数の CI ワークフローがある日は**最も悪いもの**を名乗る
// （「最新の run を採る」だと ci.yml が緑・lighthouse.yml が赤の日に緑を出してしまう）。
// UNKNOWN_STATUS を success / in_progress より前に置くのは fail-closed のため
// （GitHub が将来新しい結論を増やしたとき、それが success に打ち消されて消えないように）。
const STATUS_PRECEDENCE = [
  "failure", // 失敗
  "timed_out", // 制限時間超過
  "action_required", // 人の操作待ち（止まっている）
  "cancelled", // 中止
  "stale", // 結果が無効になった
  UNKNOWN_STATUS, // 知らない結論（成功で打ち消されない位置に置く）
  "in_progress", // まだ実行中
  "success", // 成功
];

// CI の判定が付いたコミットを何件まで遡るか。updater 自身のコミットが連続しても届く深さにする。
const COMMIT_LOOKBACK = 10;

// ワークフロー（.github/workflows/*.yml）が「本物の CI」かを名前とパスで判定する
function isCiWorkflow(workflow) {
  if (!workflow) return false; // 値が無ければ対象外
  const name = workflow.name || ""; // 表示名（例: "CI"）
  const path = workflow.path || ""; // ファイルパス（例: ".github/workflows/ci.yml"）
  if (EXCLUDE_RE.test(name) || EXCLUDE_RE.test(path)) return false; // updater 等は除外
  return CI_NAME_RE.test(name) || CI_NAME_RE.test(path); // どちらかが CI のパターンに当たれば採用
}

// 1 件の run が「CI の判定として読んでよい run」かを判定する
function isCiRun(run) {
  if (!run) return false; // 値が無ければ対象外
  // **CI を追いかける後続ワークフローは CI ではない。** `workflow_run` で起動する run は
  // 定義上 CI の完了後に作られるので、時刻で選ぶとこちらが必ず勝つ（上の (1)）。
  // 名前で `verify` を禁じる手は採らない — 本物の CI が verify を名乗る権利を奪うし、
  // 後続ワークフローの名前は repo ごとに違うので綴りを足し続けることになる。
  if (run.event === "workflow_run") return false; // 後続ワークフローの run は除外
  return isCiWorkflow({ name: run.name, path: run.path }); // 名前／パスの条件はワークフローと共通
}

// run から「表示する状態」を取り出す。判定が無い run には null を返す
function statusOf(run) {
  if (run && run.conclusion) return run.conclusion; // 結論が出ていればそれが状態
  if (run && run.status === "completed") return null; // 完了したのに結論が無い＝判定なし
  return "in_progress"; // まだ終わっていない
}

// 状態の優先順位（小さいほど悪い＝優先して名乗る）を返す
function rankOf(status) {
  const i = STATUS_PRECEDENCE.indexOf(status); // 既知の綴りなら位置がそのまま順位
  return i === -1 ? STATUS_PRECEDENCE.indexOf(UNKNOWN_STATUS) : i; // 知らない綴りは目印の位置へ
}

// run の一覧から「このコミットの CI 判定」を 1 つ決める。判定が無ければ null
function pickVerdict(runs) {
  const scored = []; // 採用候補（状態と順位を添えたもの）
  for (const run of runs || []) {
    if (!isCiRun(run)) continue; // CI の run でなければ飛ばす
    const status = statusOf(run); // 表示する状態を取り出す
    if (!status) continue; // 判定が無い run は飛ばす
    if (VERDICTLESS_CONCLUSIONS.has(status)) continue; // skipped / neutral は判定として扱わない
    scored.push({ run, status, rank: rankOf(status) }); // 候補に積む
  }
  if (scored.length === 0) return null; // 候補が 1 つも無ければ判定なし
  // まず悪い順、同じ悪さなら新しい順に並べる
  scored.sort((a, b) => a.rank - b.rank || new Date(b.run.created_at) - new Date(a.run.created_at));
  const best = scored[0]; // 先頭が名乗るべき判定
  return { status: best.status, run_url: best.run.html_url || "" }; // 状態と、根拠になる実行ページ
}

// 1 コミット分の CI run を、CI のワークフローごとに引いて集める。
// **リポジトリ全体の最新 run を引かない**のが要点（上の (2)）。schedule で何千件走る
// ワークフローがあっても、ワークフロー単位で引けば CI の run が押し出されることがない。
async function collectCiRuns({ workflows, listWorkflowRuns, sha }) {
  const collected = []; // 集めた run
  for (const workflow of workflows || []) {
    if (!isCiWorkflow(workflow)) continue; // CI でないワークフローは引かない
    const runs = await listWorkflowRuns({ workflow_id: workflow.id, sha }); // その sha の run を取得
    for (const run of runs || []) {
      // 二重防御: API が head_sha を無視した場合でも、表示中コミットに対する run だけを採る
      if (sha && run.head_sha !== sha) continue; // sha が違う run は捨てる
      collected.push(run); // 条件を満たした run を積む
    }
  }
  return collected; // 集めた run をまとめて返す
}

// 既定ブランチの直近コミットを新しい順に辿り、最初に判定が付いたコミットの結果を返す。
// 返り値の sha7 / is_head が「どのコミットの判定か」を持つので、呼び出し側（画面）は
// 古い判定を最新コミットの判定として黙って出すことがない（上の (3)）。
async function resolveCiVerdict({ commits, workflows, listWorkflowRuns }) {
  const list = commits || []; // コミット一覧（新しい順）
  if (list.length === 0) return null; // コミットが無ければ判定なし
  const headSha = list[0].sha; // 表示中の最新コミット
  for (const commit of list) {
    const runs = await collectCiRuns({ workflows, listWorkflowRuns, sha: commit.sha }); // その sha の CI run
    const verdict = pickVerdict(runs); // 判定を 1 つ決める
    if (!verdict) continue; // 判定が無ければ 1 つ前のコミットへ遡る
    return {
      status: verdict.status, // 名乗る状態
      run_url: verdict.run_url, // 根拠の実行ページ
      sha7: commit.sha.slice(0, 7), // この判定が属するコミット（短縮 sha）
      is_head: commit.sha === headSha, // 表示中の最新コミットそのものか
    };
  }
  return null; // 遡っても判定が無ければ判定なし
}

module.exports = {
  CI_NAME_RE,
  EXCLUDE_RE,
  VERDICTLESS_CONCLUSIONS,
  UNKNOWN_STATUS,
  STATUS_PRECEDENCE,
  COMMIT_LOOKBACK,
  isCiWorkflow,
  isCiRun,
  statusOf,
  rankOf,
  pickVerdict,
  collectCiRuns,
  resolveCiVerdict,
};
