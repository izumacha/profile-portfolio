import { test, expect } from "@playwright/test";
// スクロール連動アニメーションを事前に発火させる共有ヘルパー
// （スクリーンショット自動撮影 scripts/capture-screenshots.mjs と共用。CLAUDE.md §6 DRY）
import { primeScrollAnimations } from "../scripts/lib/scroll-priming.mjs";

test("index visual snapshot", async ({ page }) => {
  await page.goto("/index.html");
  await page.setViewportSize({ width: 1280, height: 720 });
  // index.html はカード/タイムライン項目を IntersectionObserver で検知してからフェードイン
  // させる（初期状態は opacity:0）ため、fullPage で撮る前にページを一巡させて全要素の
  // 交差判定を発火させる（詳細は共有ヘルパー側のコメントを参照）
  await primeScrollAnimations(page);
  await expect(page).toHaveScreenshot("index.png", { fullPage: true });
});

test("resume visual snapshot", async ({ page }) => {
  await page.goto("/resume.html");
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page).toHaveScreenshot("resume.png", { fullPage: true });
});

