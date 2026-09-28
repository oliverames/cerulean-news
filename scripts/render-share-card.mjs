// Renders site/share-card.html to site/share-card.png (1200x630) with headless
// Chromium. Playwright is not a project dependency; run this where it is
// installed globally, for example:
//   NODE_PATH=$(npm root -g) node scripts/render-share-card.mjs
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const template = fileURLToPath(new URL("../site/share-card.html", import.meta.url));
const output = fileURLToPath(new URL("../site/share-card.png", import.meta.url));

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
  });
  await page.goto(pathToFileURL(template).href);
  await page.screenshot({ path: output, type: "png" });
} finally {
  await browser.close();
}
console.log(`Wrote ${output}`);
