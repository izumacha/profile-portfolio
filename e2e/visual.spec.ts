import { test, expect } from "@playwright/test";

test("index visual snapshot", async ({ page }) => {
  await page.goto("/index.html");
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page).toHaveScreenshot("index.png", { fullPage: true });
});

test("resume visual snapshot", async ({ page }) => {
  await page.goto("/resume.html");
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page).toHaveScreenshot("resume.png", { fullPage: true });
});

