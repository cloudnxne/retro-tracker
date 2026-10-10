// Renders public/icon.svg to the PNG sizes Android needs (it ignores SVG manifest icons for installs).
// Usage: node scripts/render-icons.mjs
import fs from 'node:fs';
import { chromium } from '@playwright/test';

const svg = fs.readFileSync('public/icon.svg', 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [192, 512]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: `public/icon-${size}.png`, clip: { x: 0, y: 0, width: size, height: size } });
}
await browser.close();
console.log('wrote public/icon-192.png, public/icon-512.png');
