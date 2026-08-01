/**
 * 撮影用のごく小さな静的ファイルサーバー。
 *
 * index.html は `data/portfolio.json` を fetch で読み込むため、`file://` で開くと
 * CORS に阻まれて内容が空のまま描画されてしまう。撮影時も実際の閲覧と同じ HTTP 経由に
 * するためにローカルサーバーを立てる。
 *
 * 依存を増やさない（CLAUDE.md §9 サプライチェーン最小化）ため外部パッケージは使わず、
 * Node 標準の http / fs だけで組み立てる。
 */

// HTTP サーバーを作るための Node 標準モジュール
import { createServer } from "node:http";
// ファイル読み込み・存在確認に使う Node 標準モジュール（Promise 版）
import { readFile, stat } from "node:fs/promises";
// パス結合・正規化に使う Node 標準モジュール
import { join, normalize, extname, resolve, sep } from "node:path";

// 拡張子 → Content-Type の対応表。ここに無い拡張子は汎用のバイナリ扱いにする
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8", // HTML ページ
  ".css": "text/css; charset=utf-8", // スタイルシート
  ".js": "text/javascript; charset=utf-8", // スクリプト
  ".json": "application/json; charset=utf-8", // portfolio.json などのデータ
  ".svg": "image/svg+xml", // favicon 等のベクタ画像
  ".jpg": "image/jpeg", // アバター画像
  ".jpeg": "image/jpeg", // アバター画像（別表記）
  ".png": "image/png", // ラスタ画像
  ".pdf": "application/pdf", // 資格証明書
};

// 拡張子が対応表に無かったときに使う既定の Content-Type
const DEFAULT_CONTENT_TYPE = "application/octet-stream";

/**
 * 指定ディレクトリを配信する静的サーバーを起動する。
 *
 * @param {string} rootDir 配信するディレクトリの絶対パス
 * @param {number} port 待ち受けポート番号
 * @returns {Promise<{ origin: string, close: () => Promise<void> }>} 配信元 URL と停止関数
 */
export async function startStaticServer(rootDir, port) {
  // 配信ルートを絶対パスに正規化する（後段のパストラバーサル判定の基準にする）
  const root = resolve(rootDir);

  // リクエストごとにファイルを読み出して返すサーバーを組み立てる
  const server = createServer(async (req, res) => {
    try {
      // クエリ文字列を除いたパス部分だけを取り出す（第 2 引数はパース用のダミー基準 URL）
      const { pathname } = new URL(req.url ?? "/", "http://localhost");
      // パーセントエンコードを戻し、末尾が "/" ならディレクトリ既定ファイルを補う
      const decoded = decodeURIComponent(pathname);
      // ルート直下（"/"）や末尾スラッシュは index.html を指すものとして扱う
      const relative = decoded.endsWith("/") ? `${decoded}index.html` : decoded;
      // 先頭の "/" を外したうえで配信ルートと結合し、".." を畳んだ実パスを求める
      const filePath = normalize(join(root, relative.replace(/^\/+/, "")));

      // 外部由来のパスをそのまま使わず、配信ルート配下に収まっているかを検証する
      // （"../../etc/passwd" のようなパストラバーサルを防ぐ。CLAUDE.md §9 最小権限・最小公開）
      if (filePath !== root && !filePath.startsWith(root + sep)) {
        // ルート外を指すリクエストは中身を返さず 403 で拒否する
        res.writeHead(403).end("Forbidden");
        return;
      }

      // 対象がファイルとして存在するかを確認する（ディレクトリ指定は 404 扱いにする）
      const stats = await stat(filePath);
      // ディレクトリを直接要求された場合は配信対象にしない
      if (!stats.isFile()) {
        // ファイルでなければ 404 を返して終了する
        res.writeHead(404).end("Not Found");
        return;
      }

      // ファイル本体をバイト列として読み込む
      const body = await readFile(filePath);
      // 拡張子から Content-Type を決める（未知の拡張子は汎用バイナリ）
      const contentType = CONTENT_TYPES[extname(filePath).toLowerCase()] ?? DEFAULT_CONTENT_TYPE;
      // 200 OK とヘッダを返し、読み込んだ内容を本文として送る
      res.writeHead(200, { "content-type": contentType }).end(body);
    } catch {
      // 読み込み失敗（存在しないパス等）は詳細を外に出さず 404 にまとめる
      res.writeHead(404).end("Not Found");
    }
  });

  // 指定ポートで待ち受け開始し、listening イベントが来るまで待つ
  await new Promise((resolveListen, rejectListen) => {
    // 起動途中のエラー（ポート使用中など）は Promise の失敗として伝える
    server.once("error", rejectListen);
    // 待ち受け準備が整ったら Promise を解決する（127.0.0.1 限定で外部公開しない）
    server.listen(port, "127.0.0.1", () => resolveListen());
  });

  // 撮影スクリプトから使う「配信元 URL」と「停止関数」を返す
  return {
    // ページを開くときのベース URL
    origin: `http://127.0.0.1:${port}`,
    // 撮影完了後にサーバーを閉じるための関数（クローズ完了まで待つ）
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  };
}
