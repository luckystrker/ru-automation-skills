#!/usr/bin/env node
/** Быстрый поиск по нескольким уточняющим запросам: node stores/yarche-quick.mjs "запрос" "запрос" ...
 *  Показывает первые 5 доступных карточек: имя, цена, вес. */
import { loadStoreEnv, profileDir, proxyFor } from "./proxy.mjs";
import { loadPlaywright } from "./playwright.mjs";

const BASE = "https://yarcheplus.ru";
const queries = process.argv.slice(2);
const env = loadStoreEnv();
const { chromium } = await loadPlaywright();
const context = await chromium.launchPersistentContext(profileDir(env), {
	headless: true,
	args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
	proxy: proxyFor(env),
	locale: "ru-RU",
	timezoneId: "Asia/Novosibirsk",
	viewport: { width: 1400, height: 1000 },
});
const page = context.pages()[0] ?? (await context.newPage());
for (const query of queries) {
	await page.goto(`${BASE}/search?query=${encodeURIComponent(query)}`, { timeout: 60_000, waitUntil: "domcontentloaded" }).catch(() => {});
	await page.waitForTimeout(3500);
	const cards = await page.evaluate(() =>
		[...document.querySelectorAll('[class*="product-card-template"]')].map((card) => {
			const text = (card.innerText || "").replace(/\s+/g, " ").trim();
			const price = text.match(/(\d[\d\s]*,\d{2})\s*₽/)?.[1] ?? "";
			const button = [...card.querySelectorAll("button")].find((b) => /В корзину|Уведомить/.test(b.innerText));
			return { text: text.slice(0, 110), price, available: /В корзину/.test(button?.innerText ?? "") };
		}),
	);
	console.log(`\n=== ${query} (${cards.length})`);
	for (const c of cards.filter((c) => c.available).slice(0, 5)) console.log(`  ${c.price} ₽ — ${c.text}`);
	if (!cards.filter((c) => c.available).length) console.log("  нет доступных; примеры:", cards.slice(0, 3).map((c) => c.text).join(" || "));
	await page.waitForTimeout(800);
}
await context.close();
