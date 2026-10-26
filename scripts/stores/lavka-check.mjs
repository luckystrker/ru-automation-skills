#!/usr/bin/env node
/**
 * lavka-check.mjs — первая разведка Яндекс Лавки: открыть страницу через наш прокси
 * и посмотреть, что отдаёт Яндекс (капча? каталог? гео?).
 *
 *   xvfb-run -a node stores/lavka-check.mjs --headed
 *
 * Скриншот: stores/screenshots/lavka-check.png
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadStoreEnv, proxyFor } from "./proxy.mjs";
import { loadPlaywright } from "./playwright.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILE = join(HERE, "browser-profile-lavka");
const env = loadStoreEnv();
const headed = process.argv.includes("--headed");

const { chromium } = await loadPlaywright();
const launch = {
	headless: !headed,
	args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
	proxy: proxyFor(env),
};
const context = await chromium.launchPersistentContext(PROFILE, {
	...launch,
	locale: "ru-RU",
	timezoneId: "Asia/Novosibirsk",
	viewport: { width: 1400, height: 1000 },
});
const page = context.pages()[0] ?? (await context.newPage());
try {
	const response = await page.goto("https://lavka.yandex.ru/", { timeout: 90_000, waitUntil: "domcontentloaded" });
	await page.waitForTimeout(8000);
	console.log("status:", response?.status());
	console.log("url:", page.url());
	console.log("title:", await page.title());
	const text = (await page.evaluate(() => document.body?.innerText ?? "")).replace(/\s+/g, " ").slice(0, 700);
	console.log("текст:", text);
} catch (error) {
	console.log("ошибка:", String(error?.message ?? error).slice(0, 300));
	console.log("url:", page.url());
}
mkdirSync(join(HERE, "screenshots"), { recursive: true });
await page.screenshot({ path: join(HERE, "screenshots", "lavka-check.png") }).catch(() => {});
console.log("скриншот: stores/screenshots/lavka-check.png");
await context.close();
