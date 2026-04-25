# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Project

個人ポートフォリオサイト（静的 HTML/CSS/JS）。GitHub Pages でホスティング。ビルドツール・パッケージマネージャは使用しない。

## ファイル構成

| ファイル | 説明 |
|---|---|
| `index.html` | メインポートフォリオページ（ダークテーマ） |
| `resume.html` | 履歴書ページ（ライトテーマ、印刷対応） |
| `avatar.jpg` | プロフィール画像 |
| `*.pdf` | 資格証明書 |

## ローカル確認

ビルド不要。以下のいずれかで確認:

```bash
open index.html                    # ブラウザで直接
python -m http.server 8000         # ローカルサーバー
```

## デザイン規約

### カラーパレット（CSS 変数）

- 色の変更は `:root` の CSS 変数（`--primary`, `--accent`, `--bg-dark` 等）を通じて行う。個別の要素に直接カラーコードを書かない。
- ダークテーマ: `--bg-dark: #0f172a`, `--primary: #6366f1`, `--accent: #22d3ee`

### レスポンシブデザイン

- ブレークポイント: 968px（タブレット）, 768px（モバイル）
- グリッドレイアウトは `auto-fit, minmax()` を使い、メディアクエリを最小限に抑える。
- フォントサイズは `clamp()` で流体タイポグラフィを適用する。

### コンポーネントスタイル

- カード: `border-radius: 16px〜24px`, ホバーで `translateY(-5px)` + グロー効果
- ボタン: `--gradient-1` グラデーション背景、ホバーで `scale(1.05)`
- アニメーション: Intersection Observer でスクロール連動。新しいセクション追加時は `.observe()` に登録する。

## コーディング規約

- HTML: セマンティックタグ（`<section>`, `<header>`, `<nav>`, `<footer>`）を使用。
- CSS: BEM 風の命名（`.section-header`, `.skill-card`, `.timeline-item`）。
- JS: Vanilla JavaScript のみ。外部ライブラリを追加しない（Google Fonts 除く）。
- 画像: `alt` 属性を必ず設定。外部リンクには `rel="noopener noreferrer"` を付与。
- 言語: `lang="ja"`。コンテンツは日本語。

## セクション追加時のチェックリスト

1. `index.html` に `<section id="xxx">` を追加
2. ナビゲーションリンクに `<a href="#xxx">` を追加
3. Intersection Observer の `.observe()` 対象に新しい要素のセレクタを追加
4. 768px 以下のレスポンシブ表示を確認
5. `resume.html` にも対応セクションが必要か検討
