# Profile Portfolio

個人プロフィールページのポートフォリオサイトです。

## 特徴

- レスポンシブデザイン
- ダークテーマ
- モダンなUI/UXデザイン
- スキル、代表プロジェクト、活動履歴、リンクの表示

## 代表プロジェクト

評価いただく際は、まず以下の**主力プロジェクト 3 本**をご覧ください。補助プロジェクトは学習過程で取り組んだ作品です。

### 主力プロジェクト

| プロジェクト | 概要 | 主な技術 |
|---|---|---|
| [helpdesk-hub](https://github.com/izumacha/helpdesk-hub) | 社内ヘルプデスク向けチケット管理システム。起票から対応・SLA 期限監視・エスカレーション・ダッシュボード分析・FAQ 化までを一元管理し、対応漏れと属人化を防止。 | Next.js 15 / React 19 / TypeScript / Prisma 5 / PostgreSQL / Auth.js / Tailwind CSS v4 |
| [incident-insight](https://github.com/izumacha/incident-insight) | 医療現場のインシデント管理ツール。報告から 5 Whys による根本原因分析・再発防止策・効果評価まで PDCA を一気通貫で管理し、再発を自動検知。 | C# / ASP.NET Core 8 MVC / EF Core 8 / SQLite / Bootstrap 5 / Chart.js |
| [AI-Docker-Environment](https://github.com/izumacha/AI-Docker-Environment) | Claude Code を安全に動かすサンドボックス Docker 環境。iptables/ipset によるデフォルト拒否の egress 制限と認証情報の隔離でセキュリティを確保。 | Docker / Shell Script / iptables・ipset / GitHub Actions |

### 補助プロジェクト

| プロジェクト | 概要 | 主な技術 |
|---|---|---|
| [my-first-ai-app](https://github.com/izumacha/my-first-ai-app) | 日常生活の疑問に AI がチャットで回答する「AI 暮らしアシスタント」。ストリーミング応答とカテゴリ最適化プロンプトに対応。 | Next.js 15 / TypeScript / Claude API (Sonnet 4.6) / Vercel AI SDK / Tailwind CSS v4 |
| [my-task-manager](https://github.com/izumacha/my-task-manager) | 1 日のタスクを時間割のように時間軸へ配置するタイムライン型デスクトッププランナー。完了時点を起点に繰り返す「完了起点リピート」が特徴。 | Python 3.10+ / tkinter / Desktop App |

## 技術スタック

- HTML5
- CSS3
- レスポンシブデザイン

## 使用方法

1. `index.html` をブラウザで開く
2. ローカルサーバーで確認する場合は、以下のコマンドを実行：

```bash
# Python 3の場合
python -m http.server 8000

# Node.jsの場合（http-serverがインストールされている場合）
npx http-server
```

## カスタマイズ

- アバター画像のパスを変更
- 個人情報の更新
- スタイルの調整

## ライセンス

MIT License
