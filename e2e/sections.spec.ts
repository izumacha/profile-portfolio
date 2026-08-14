// 主要セクションの表示とリンクの機能的な回帰テスト。
// ビジュアルスナップショット (visual.spec.ts) が検知できない「セクション消失・アンカー切れ・
// リンク 404・セキュリティ属性の欠落・動的バッジ描画の破損」を検証する (issue #80)。
import { test, expect, type Page } from "@playwright/test";

// index.html の主要セクションと期待する見出しの対応表 (§6 定数の一元管理)。
// セクション追加時はここに 1 行足せば表示検証が効く。
const INDEX_SECTIONS: ReadonlyArray<{ id: string; title: string }> = [
  { id: "about", title: "自己紹介" }, // About セクション
  { id: "skills", title: "スキルセット" }, // Skills セクション
  { id: "works", title: "代表プロジェクト" }, // Works セクション
  { id: "certifications", title: "資格・認定" }, // Certifications セクション
  { id: "timeline", title: "学習履歴" }, // Timeline セクション
  { id: "contact", title: "お問い合わせ" }, // Contact セクション
];

// resume.html の主要セクション見出しの期待値 (印刷向けページ側の表示検証に使う)
const RESUME_SECTION_TITLES: ReadonlyArray<string> = [
  "自己紹介", // 自己紹介セクション
  "スキル", // スキルセクション
  "代表プロジェクト", // プロジェクトセクション
  "資格・認定", // 資格セクション
  "学習履歴", // 学習履歴セクション
  "リンク", // 外部リンクセクション
];

// Works セクションに静的マークアップとして存在するカードの枚数 (主力 3 + 補助 2)
const WORK_CARD_COUNT = 5;
// data/portfolio.json からライブバッジを描画するカード (data-repo-key 付き) の枚数
const PROOF_CARD_COUNT = 3;
// モバイル表示の検証に使うビューポート (CLAUDE.md §A のブレークポイント 768px より狭い幅)
const MOBILE_VIEWPORT = { width: 375, height: 667 };

// ページ内アンカー (href="#xxx") の遷移先が実在するかをまとめて検証するヘルパー。
// index / resume の両方から使うため関数に切り出す (§6 DRY)。
async function expectAnchorsResolve(page: Page): Promise<void> {
  // ページ内リンクの href をすべて収集する ("#" 単独のプレースホルダは対象外)
  const anchors = await page
    .locator('a[href^="#"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute("href") ?? ""));
  // アンカーが 1 つも無いページはこの検証の前提が崩れているので失敗させる
  expect(anchors.length).toBeGreaterThan(0);
  // 収集した各アンカーについて遷移先要素の存在を確認する
  for (const href of anchors) {
    // "#" 以降の ID 部分を取り出す
    const id = href.slice(1);
    // 空 ID ("#" 単独) は遷移先を持たないプレースホルダなのでスキップする
    if (id === "") continue;
    // 対応する ID を持つ要素がちょうど 1 つ存在することを確認する
    // (属性セレクタ表記にすることで、ID に記号が含まれても CSS セレクタとして安全に扱える)
    await expect(page.locator(`[id="${id}"]`), `アンカー ${href} の遷移先`).toHaveCount(1);
  }
}

// 外部リンクのセキュリティ属性 (target="_blank" + rel="noopener noreferrer") を検証するヘルパー (§7)
async function expectExternalLinksSafe(page: Page): Promise<void> {
  // http(s) で始まる href を持つ <a> 要素をすべて取得する
  const externalLinks = page.locator('a[href^="http"]');
  // 外部リンクの総数を取得する
  const count = await externalLinks.count();
  // 外部リンクが 1 つも無ければマークアップが激変しているので失敗させる
  expect(count).toBeGreaterThan(0);
  // 1 件ずつ属性を確認する
  for (let i = 0; i < count; i++) {
    // i 番目の外部リンクを取り出す
    const link = externalLinks.nth(i);
    // 検証失敗時にどのリンクかを特定できるよう href をメッセージに含める
    const href = await link.getAttribute("href");
    // 別タブで開く設定になっていることを確認する
    await expect(link, `${href} の target`).toHaveAttribute("target", "_blank");
    // タブナビング防止の rel 属性が付いていることを確認する
    await expect(link, `${href} の rel`).toHaveAttribute("rel", "noopener noreferrer");
  }
}

// サイト内リンク (同一オリジンのファイルへのリンク) が HTTP 200 で解決するかを検証するヘルパー
async function expectLocalLinksOk(page: Page): Promise<void> {
  // ページ内の全リンクの href を絶対 URL として収集する
  const urls = await page
    .locator("a[href]")
    .evaluateAll((els) =>
      els
        .map((el) => (el as HTMLAnchorElement).href) // href プロパティは絶対 URL に解決済み
        .filter((href) => href.startsWith(location.origin)) // 同一オリジンのリンクだけに絞る
        .filter((href) => !href.includes("#")) // ページ内アンカーは expectAnchorsResolve が担当
    );
  // 重複 (同じ PDF への複数リンク等) を除いて無駄なリクエストを減らす
  const unique = [...new Set(urls)];
  // サイト内リンクが 1 つも無ければマークアップが激変しているので失敗させる
  expect(unique.length).toBeGreaterThan(0);
  // 各リンク先へ実際に HTTP リクエストを送り 200 系で応答することを確認する
  for (const url of unique) {
    // Playwright の APIRequestContext で GET し、失敗時は URL 付きで報告する
    const res = await page.request.get(url);
    expect(res.ok(), `${url} が ${res.status()} を返した`).toBe(true);
  }
}

// ─── index.html ────────────────────────────────────────────────────────────

test.describe("index.html の主要セクション", () => {
  // 各テストの前にトップページを開いておく
  test.beforeEach(async ({ page }) => {
    // baseURL (playwright.config.ts) 配下の index.html を開く
    await page.goto("/index.html");
  });

  test("ヒーローとナビゲーションが表示される", async ({ page }) => {
    // ヒーローの氏名見出し (h1) が表示されていることを確認する
    await expect(page.locator("h1.hero-name")).toHaveText("泉 将貴");
    // ナビゲーションバーが表示されていることを確認する
    await expect(page.locator("nav.nav")).toBeVisible();
    // ナビ内のリンクがセクション数と同じ 6 件あることを確認する
    await expect(page.locator(".nav-links a")).toHaveCount(INDEX_SECTIONS.length);
  });

  test("主要 6 セクションが期待した見出しで表示される", async ({ page }) => {
    // 対応表の各セクションを順に検証する
    for (const { id, title } of INDEX_SECTIONS) {
      // セクション要素そのものが存在し表示されていることを確認する
      await expect(page.locator(`section#${id}`), `#${id} セクション`).toBeVisible();
      // セクション内の見出し (h2.section-title) が期待テキストであることを確認する
      await expect(
        page.locator(`section#${id} h2.section-title`),
        `#${id} の見出し`
      ).toHaveText(title);
    }
  });

  test("ナビ・スキップリンク・ページ内アンカーの遷移先がすべて存在する", async ({ page }) => {
    // ナビの各リンク・スキップリンク (#main-content) を含む全アンカーの遷移先を検証する
    await expectAnchorsResolve(page);
    // スキップリンクの遷移先 (本文ランドマーク) が存在することを明示的に確認する
    await expect(page.locator("#main-content")).toHaveCount(1);
  });

  test("ナビリンクをクリックすると対象セクションへ遷移する", async ({ page }) => {
    // 代表として Works へのナビリンクをクリックする
    await page.locator('.nav-links a[href="#works"]').click();
    // 本サイトのページ内リンクは preventDefault + scrollIntoView で処理され URL ハッシュは
    // 変わらない設計のため、遷移先セクションがビューポート内に入ることをもって検証する
    await expect(page.locator("section#works")).toBeInViewport();
  });

  test("サイト内リンク (resume.html・証明書 PDF) が 200 で解決する", async ({ page }) => {
    // 同一オリジンの全リンク先が HTTP 200 系で応答することを確認する
    await expectLocalLinksOk(page);
  });

  test("外部リンクに target=_blank と rel=noopener noreferrer が付いている", async ({ page }) => {
    // 全外部リンクのセキュリティ属性を確認する (§7 a11y / §9 タブナビング防止)
    await expectExternalLinksSafe(page);
  });
});

test.describe("index.html の Works セクション", () => {
  // 各テストの前にトップページを開いておく
  test.beforeEach(async ({ page }) => {
    // baseURL 配下の index.html を開く
    await page.goto("/index.html");
  });

  test("プロジェクトカード 5 枚と GitHub リンクが表示される", async ({ page }) => {
    // カード総数 (主力 3 + 補助 2) を確認する
    await expect(page.locator(".work-card")).toHaveCount(WORK_CARD_COUNT);
    // 各カードの GitHub リンクを順に確認する
    for (let i = 0; i < WORK_CARD_COUNT; i++) {
      // i 番目のカード内の GitHub リンクを取り出す
      const repoLink = page.locator(".work-card").nth(i).locator("a.work-repo");
      // リンクが izumacha 配下のリポジトリを指していることを確認する
      await expect(repoLink).toHaveAttribute("href", /^https:\/\/github\.com\/izumacha\//);
    }
  });

  test("portfolio.json 由来の CI バッジが主力カードに描画される", async ({ page }) => {
    // ライブバッジ描画対象 (data-repo-key 付き) のカードが 3 枚あることを確認する
    const proofCards = page.locator(".work-card[data-repo-key]");
    await expect(proofCards).toHaveCount(PROOF_CARD_COUNT);
    // 各カードについて fetch → 描画の結果を確認する
    for (let i = 0; i < PROOF_CARD_COUNT; i++) {
      // i 番目のカードのバッジ入れ ([data-proof]) 内の先頭バッジを取り出す
      const firstBadge = proofCards.nth(i).locator("[data-proof] .proof-badge").first();
      // fetch 完了後にバッジが現れ、CI 状態ラベル (例: "CI 成功") を含むことを確認する
      // (toHaveText は自動リトライするため fetch の完了待ちを兼ねる)
      await expect(firstBadge).toHaveText(/^CI /);
    }
  });
});

test.describe("index.html のモバイル表示", () => {
  // このグループはモバイル幅のビューポートで実行する
  test.use({ viewport: MOBILE_VIEWPORT });

  test("ハンバーガーメニューで開閉でき aria-expanded が同期する", async ({ page }) => {
    // モバイル幅でトップページを開く
    await page.goto("/index.html");
    // ハンバーガーボタンを取得する
    const toggle = page.locator("button.nav-toggle");
    // モバイル幅ではハンバーガーボタンが表示されることを確認する
    await expect(toggle).toBeVisible();
    // 初期状態は閉じている (aria-expanded=false) ことを確認する
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    // ボタンをクリックしてメニューを開く
    await toggle.click();
    // 開いた状態が aria-expanded に反映されることを確認する
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    // メニュー内のリンク (先頭の About) が見えるようになったことを確認する
    await expect(page.locator('.nav-links a[href="#about"]')).toBeVisible();
    // メニュー内のリンクをクリックする
    await page.locator('.nav-links a[href="#about"]').click();
    // クリック後はメニューが自動で閉じる (開いたまま残らない) ことを確認する
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    // リンク先セクションへスクロールしていることを確認する (ハッシュは変えない設計のため)
    await expect(page.locator("section#about")).toBeInViewport();
  });
});

// ─── resume.html ───────────────────────────────────────────────────────────

test.describe("resume.html の主要セクション", () => {
  // 各テストの前に履歴書ページを開いておく
  test.beforeEach(async ({ page }) => {
    // baseURL 配下の resume.html を開く
    await page.goto("/resume.html");
  });

  test("氏名と主要セクション見出しが表示される", async ({ page }) => {
    // 氏名の見出し (h1) が表示されていることを確認する
    await expect(page.locator("h1.name")).toHaveText("泉将貴");
    // 見出し (h2.section-title) がセクション数ぶん存在することを確認する
    await expect(page.locator("h2.section-title")).toHaveCount(RESUME_SECTION_TITLES.length);
    // 各見出しのテキストを順に確認する
    for (let i = 0; i < RESUME_SECTION_TITLES.length; i++) {
      // i 番目の見出しが期待テキストであることを確認する
      await expect(page.locator("h2.section-title").nth(i)).toHaveText(RESUME_SECTION_TITLES[i]);
    }
  });

  test("外部リンクに target=_blank と rel=noopener noreferrer が付いている", async ({ page }) => {
    // 履歴書ページ側の外部リンクにもセキュリティ属性が付いていることを確認する
    await expectExternalLinksSafe(page);
  });
});
