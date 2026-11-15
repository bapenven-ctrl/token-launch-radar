// Capture the 3 judge screenshots from a built /output dir (board, detail, filtered).
import { chromium } from 'playwright-core';
import { join } from 'node:path';

const outDir = process.argv[2];
const shotsDir = process.argv[3];
const url = 'file://' + join(outDir, 'dashboard', 'index.html');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
await page.goto(url, { waitUntil: 'load' });
await page.waitForSelector('tbody tr[data-slug]');
await page.waitForTimeout(350);

// 1 — the board (slightly shorter frame: the full table is dense)
await page.setViewportSize({ width: 1440, height: 830 });
await page.waitForTimeout(150);
await page.screenshot({ path: join(shotsDir, '1-board.png') });
await page.setViewportSize({ width: 1440, height: 1080 });
await page.waitForTimeout(150);

// 2 — a detail view: open the #2 row, bring the detail panel to the top
await page.click('tbody tr[data-slug]:nth-child(2)');
await page.waitForSelector('#detail');
await page.evaluate(() => {
  const d = document.getElementById('detail');
  const y = d.getBoundingClientRect().top + window.scrollY - 14;
  window.scrollTo(0, y);
});
await page.waitForTimeout(250);
await page.screenshot({ path: join(shotsDir, '2-detail.png') });

// 3 — a filtered view: Lending category across the whole board, back at the top
await page.selectOption('#cat', 'Lending');
await page.waitForTimeout(250);
await page.evaluate(() => window.scrollTo(0, 0));
await page.setViewportSize({ width: 1440, height: 800 });
await page.waitForTimeout(150);
await page.screenshot({ path: join(shotsDir, '3-filtered.png') });

await browser.close();
console.log('screenshots written to', shotsDir);
