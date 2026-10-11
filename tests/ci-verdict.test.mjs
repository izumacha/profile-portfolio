// `scripts/lib/ci-verdict.cjs` の判定を固定するテスト。`node --test` で走る（追加依存なし）。
//
// **固定しているのは「過去に実際に出荷されていた 3 つの誤り」が戻らないこと**で、
// どのケースも `data/portfolio.json` の履歴 59 スナップショット（236 リポジトリ観測）から
// 取った実データの形をそのまま使っている。期待値を人が決めた理想ではなく実測に置くことで、
// 「直したつもりで直っていない」状態をテストが素通りできないようにしている。
import { describe, it } from "node:test"; // Node 同梱のテストランナー
import assert from "node:assert/strict"; // Node 同梱の表明（厳密比較）
import ciVerdict from "../scripts/lib/ci-verdict.cjs"; // 検査対象（CommonJS を既定 import で読む）

const {
  COMMIT_LOOKBACK,
  STATUS_PRECEDENCE,
  UNKNOWN_STATUS,
  isCiWorkflow,
  isCiRun,
  statusOf,
  pickVerdict,
  collectCiRuns,
  resolveCiVerdict,
} = ciVerdict; // 使う関数と定数を取り出す

// **フィクスチャの run_url は URL ではなく目印の文字列にしてある。** CI の link-check
// （lychee）はリポジトリ配下の平文ファイルを走査して出てきた URL を実際に叩くので、
// 実在しない GitHub の実行ページ URL を書くと 404 で CI が赤くなる（しかも原因が
// このテストと無関係な場所に出る）。判定が選ぶのは「どの run の URL か」なので、
// 文字列が URL の形をしている必要はない。
// 実測の run を 1 件作る補助。既定は「完了した成功の push run」
function run(over) {
  return Object.assign(
    {
      name: "CI", // ワークフローの表示名
      path: ".github/workflows/ci.yml", // ワークフローのファイルパス
      event: "push", // 起動イベント
      status: "completed", // 実行の進行状況
      conclusion: "success", // 結論
      created_at: "2026-10-11T12:43:34Z", // 作成時刻（並べ替えに使う）
      head_sha: "a".repeat(40), // 対象コミット
      html_url: "RUN_URL(1)", // 実行ページ
    },
    over, // 呼び出し側が上書きしたい項目
  );
}

// AI-Docker-Environment の実測（現在の main。post-ci-verify が CI より 2 分 25 秒あとに作られる）
const AI_DOCKER_RUNS = [
  run({
    name: "Post-CI Verification",
    path: ".github/workflows/post-ci-verify.yml",
    event: "workflow_run",
    conclusion: "skipped",
    created_at: "2026-10-11T12:45:59Z",
    html_url: "RUN_URL(2)",
  }),
  run({ created_at: "2026-10-11T12:43:34Z" }),
];

describe("ワークフローと run の選別", () => {
  it("検査が空回りしていない（前提の確認）", () => {
    // 実データに「後続ワークフロー」と「skipped」が本当に含まれていることを先に確かめる。
    // ここが崩れると以下のケースは何も検査していないのに緑になる
    assert.ok(
      AI_DOCKER_RUNS.some((r) => r.event === "workflow_run"),
      "実データに workflow_run 起動の run が無い",
    );
    assert.ok(
      AI_DOCKER_RUNS.some((r) => r.conclusion === "skipped"),
      "実データに skipped の run が無い",
    );
    assert.ok(COMMIT_LOOKBACK >= 2 && Number.isInteger(COMMIT_LOOKBACK), "遡る件数が 2 以上の整数でない");
  });

  it("CI を追いかける後続ワークフローの run は CI として読まない", () => {
    const follow = AI_DOCKER_RUNS[0]; // post-ci-verify の run
    // 名前・パスの条件だけなら通ってしまう（`post-ci-verify.yml` は \bci\b と verify に当たる）。
    // つまりここを弾いているのは event の判定だけで、名前の綴りには頼っていない
    assert.equal(isCiWorkflow({ name: follow.name, path: follow.path }), true);
    assert.equal(isCiRun(follow), false); // run としては除外される
  });

  it("updater 自身・デプロイ・Pages は CI として読まない", () => {
    assert.equal(isCiWorkflow({ name: "Update Portfolio Data", path: ".github/workflows/update-portfolio-data.yml" }), false);
    assert.equal(isCiWorkflow({ name: "Update Snapshots", path: ".github/workflows/update-snapshots.yml" }), false);
    assert.equal(isCiWorkflow({ name: "pages build and deployment", path: "dynamic/pages/pages-build-deployment" }), false);
  });

  it("本物の CI は名前でもパスでも拾う", () => {
    assert.equal(isCiWorkflow({ name: "CI", path: ".github/workflows/ci.yml" }), true);
    assert.equal(isCiWorkflow({ name: "Lighthouse CI", path: ".github/workflows/lighthouse.yml" }), true);
    assert.equal(isCiWorkflow({ name: "", path: ".github/workflows/e2e.yml" }), true); // 名前が空でもパスで拾う
  });

  it("進行中の run は in_progress、完了したのに結論が無い run は判定なし", () => {
    assert.equal(statusOf(run({ status: "in_progress", conclusion: null })), "in_progress");
    assert.equal(statusOf(run({ status: "completed", conclusion: null })), null);
  });
});

describe("判定の選び方", () => {
  it("後続ワークフローの skipped に負けず CI の success を名乗る（出荷されていた誤り 54 件）", () => {
    const verdict = pickVerdict(AI_DOCKER_RUNS); // 実データで判定する
    assert.deepEqual(verdict, {
      status: "success",
      run_url: "RUN_URL(1)",
    });
  });

  it("後続ワークフローの failure も CI の判定として採らない（出荷されていた誤り 2 件）", () => {
    const runs = [
      run({
        name: "Post-CI Verification",
        path: ".github/workflows/post-ci-verify.yml",
        event: "workflow_run",
        conclusion: "failure",
        created_at: "2026-07-13T00:17:33Z",
        html_url: "RUN_URL(9)",
      }),
      run({ created_at: "2026-07-12T00:15:37Z" }),
    ];
    assert.equal(pickVerdict(runs).status, "success"); // CI 自身は成功していた
  });

  it("CI が 1 つも判定を持たなければ null（遡る材料にする）", () => {
    assert.equal(pickVerdict([]), null); // run が無い
    assert.equal(pickVerdict([run({ conclusion: "skipped" })]), null); // skipped だけ
    assert.equal(pickVerdict([run({ conclusion: "neutral" })]), null); // neutral だけ
    assert.equal(pickVerdict([run({ name: "Deploy", path: ".github/workflows/deploy.yml" })]), null); // CI でない
  });

  it("CI が複数ある日は最も悪いものを名乗る（新しい成功で赤を打ち消さない）", () => {
    const runs = [
      run({ created_at: "2026-10-11T13:00:00Z", html_url: "RUN_URL(3)" }), // 新しい成功
      run({
        name: "Lighthouse CI",
        path: ".github/workflows/lighthouse.yml",
        conclusion: "failure",
        created_at: "2026-10-11T12:00:00Z",
        html_url: "RUN_URL(4)",
      }), // 古い失敗
    ];
    assert.deepEqual(pickVerdict(runs), {
      status: "failure",
      run_url: "RUN_URL(4)",
    });
  });

  it("知らない結論は success に打ち消されない（fail-closed）", () => {
    const runs = [
      run({ conclusion: "success", created_at: "2026-10-11T13:00:00Z" }),
      run({
        name: "Lighthouse CI",
        path: ".github/workflows/lighthouse.yml",
        conclusion: "a_conclusion_github_adds_later",
        created_at: "2026-10-11T12:00:00Z",
        html_url: "RUN_URL(5)",
      }),
    ];
    assert.equal(pickVerdict(runs).status, "a_conclusion_github_adds_later");
    // 目印が success / in_progress より前にあることも直接確かめる（並びを崩す変更を落とす）
    assert.ok(STATUS_PRECEDENCE.indexOf(UNKNOWN_STATUS) < STATUS_PRECEDENCE.indexOf("success"));
    assert.ok(STATUS_PRECEDENCE.indexOf(UNKNOWN_STATUS) < STATUS_PRECEDENCE.indexOf("in_progress"));
  });
});

describe("run の集め方", () => {
  const SHA = "b".repeat(40); // 対象コミット
  // helpdesk-hub の実測: 同一 sha に 90 件の run があり、うち 77 件が schedule の sla-reminders、
  // ci.yml はちょうど 1 件。リポジトリ全体を 30 件だけ引く形ではこの 1 件が必ずページ外に落ちる
  const WORKFLOWS = [
    { id: 1, name: "CI", path: ".github/workflows/ci.yml" },
    { id: 2, name: "SLA reminders", path: ".github/workflows/sla-reminders.yml" },
    { id: 3, name: "Post-CI Verification", path: ".github/workflows/post-ci-verify.yml" },
  ];

  it("schedule の大量 run に押し出されず CI の run を拾う（出荷されていた誤り 7 件）", async () => {
    const asked = []; // どのワークフローを引いたか
    const listWorkflowRuns = async ({ workflow_id, sha }) => {
      asked.push(workflow_id); // 問い合わせを記録する
      if (workflow_id === 1) return [run({ head_sha: sha, html_url: "RUN_URL(7)" })];
      if (workflow_id === 2) {
        // 77 件の schedule run（CI のパターンに当たらないので採用されない）
        return Array.from({ length: 77 }, (_, i) =>
          run({ name: "SLA reminders", path: ".github/workflows/sla-reminders.yml", event: "schedule", head_sha: sha, html_url: `RUN_URL(s${i})` }),
        );
      }
      return []; // post-ci-verify はこの sha で run 無し
    };
    const runs = await collectCiRuns({ workflows: WORKFLOWS, listWorkflowRuns, sha: SHA });
    // **ワークフロー単位で引いている**こと自体を確かめる（リポジトリ全体を 1 回引く形へ戻すと落ちる）
    assert.deepEqual(asked.sort(), [1, 3]); // CI 判定に使うワークフローだけを引く
    assert.equal(runs.length, 1); // 大量の schedule run は引いてすらいない
    assert.deepEqual(pickVerdict(runs), { status: "success", run_url: "RUN_URL(7)" });
  });

  it("表示中コミット以外の run は捨てる（古い緑を貼らない二重防御）", async () => {
    const listWorkflowRuns = async () => [run({ head_sha: "c".repeat(40) })]; // API が sha を無視した想定
    const runs = await collectCiRuns({ workflows: WORKFLOWS, listWorkflowRuns, sha: SHA });
    assert.deepEqual(runs, []); // 1 件も採らない
  });
});

describe("判定が付いたコミットまで遡る", () => {
  const WORKFLOWS = [{ id: 1, name: "CI", path: ".github/workflows/ci.yml" }]; // CI は 1 本
  const HEAD = "1".repeat(40); // updater 自身が作ったコミット（CI の run が無い）
  const PREV = "2".repeat(40); // その 1 つ前（CI が走っている）
  const COMMITS = [{ sha: HEAD }, { sha: PREV }]; // 新しい順

  it("先頭コミットに CI が無ければ遡り、どのコミットの判定かを返す（出荷されていた誤り 29 件）", async () => {
    const listWorkflowRuns = async ({ sha }) =>
      sha === PREV ? [run({ head_sha: PREV, html_url: "RUN_URL(8)" })] : [];
    const verdict = await resolveCiVerdict({ commits: COMMITS, workflows: WORKFLOWS, listWorkflowRuns });
    assert.deepEqual(verdict, {
      status: "success",
      run_url: "RUN_URL(8)",
      sha7: PREV.slice(0, 7), // 判定が属するコミット
      is_head: false, // 表示中の最新コミットではない＝画面がその旨を添える
    });
  });

  it("先頭コミットに CI があれば遡らず is_head を立てる", async () => {
    const listWorkflowRuns = async ({ sha }) => (sha === HEAD ? [run({ head_sha: HEAD })] : []);
    const verdict = await resolveCiVerdict({ commits: COMMITS, workflows: WORKFLOWS, listWorkflowRuns });
    assert.equal(verdict.sha7, HEAD.slice(0, 7));
    assert.equal(verdict.is_head, true);
  });

  it("遡っても判定が無ければ null（古い run を流用しない）", async () => {
    const listWorkflowRuns = async () => []; // どのコミットにも run が無い
    assert.equal(await resolveCiVerdict({ commits: COMMITS, workflows: WORKFLOWS, listWorkflowRuns }), null);
    assert.equal(await resolveCiVerdict({ commits: [], workflows: WORKFLOWS, listWorkflowRuns }), null);
  });
});
