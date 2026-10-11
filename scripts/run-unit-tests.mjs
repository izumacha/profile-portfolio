#!/usr/bin/env node
// tests/ のユニットテストを走らせる小さなランナー（追加依存なし）。
//
// **`node --test <パス>` を直に叩かないのはなぜか。** 実測で、対象のファイルが 1 件も
// 無いとき `node --test` は「テスト 0 件」を TAP に出して**終了コード 0 を返す**
// （`node --test tests/*.test.mjs` はシェルが展開できないとリテラルをそのまま渡すが、
// それでも rc=0 だった）。つまりテストファイルを消す・名前を変える・置き場所を移すと、
// CI は緑のまま検査が 1 つも走らない状態になる。このリポジトリが繰り返し記録している
// 「検出網が空回りしていることに気づけない」形そのものなので、先に件数を見て落とす。
import { globSync } from "node:fs"; // Node 22 同梱のグロブ（html-validate が Node 22 を要求しているのと同じ理由で使える）
import { spawnSync } from "node:child_process"; // 子プロセスでテストランナーを起動する

// ユニットテストの置き場所と命名。**ここが唯一の定義**で、他の場所に写しを持たない
const PATTERN = "tests/**/*.test.mjs";

const files = globSync(PATTERN).sort(); // 対象ファイルを集め、実行順を環境のファイル列挙順に依存させない
if (files.length === 0) {
  // 1 件も見つからないのは「全部通った」ではなく「何も検査していない」。必ず落とす（fail-closed）
  console.error(`ユニットテストが 1 件も見つかりません（${PATTERN}）。`);
  console.error("置き場所か命名を変えたなら scripts/run-unit-tests.mjs の PATTERN も同じ変更で直すこと。");
  process.exit(1); // 失敗として終了する
}

console.log(`ユニットテスト ${files.length} ファイルを実行します`); // 何件走るかを必ず出す（0 件を見逃さないため）
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" }); // いま動いている Node でそのまま実行する
// 子プロセスを起動できなかった場合（EACCES / EMFILE / ENOMEM など）は status が null で
// 理由が error にしか入らない。黙って非ゼロ終了すると「テストが落ちた」と区別できないので必ず出す（§6）
if (result.error) console.error("テストランナーを起動できませんでした:", result.error);
process.exit(result.status === null ? 1 : result.status); // シグナルで落ちた場合（status が null）も失敗として扱う
