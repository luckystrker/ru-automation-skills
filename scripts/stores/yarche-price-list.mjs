#!/usr/bin/env node
/**
 * yarche-price-list.mjs — подобрать товары в «Ярче+» по списку и отдать варианты с ценами.
 * Ничего не добавляет в корзину (безопасно, без логина и без капчи-триггеров).
 *
 * node stores/yarche-price-list.mjs --out /tmp/yarche-prices.json
 */
import { writeFileSync } from "node:fs";
import { loadStoreEnv, profileDir, proxyFor } from "./proxy.mjs";
import { loadPlaywright } from "./playwright.mjs";

const BASE = "https://yarcheplus.ru";
const items = [
	["бумага туалетная", "туалетная бумага", /бумаг/i],
	["молоко", "молоко 3,2%", /молок/i],
	["картошка", "картофель", /картоф/i],
	["курица целиком", "тушка цыпленка бройлера", /тушк|цыплен|куриц/i],
	["морковь", "морковь", /морков/i],
	["яблоки", "яблоки", /яблок/i],
	["ветчина из индейки", "ветчина из индейки", /ветчин/i],
	["зубная паста", "зубная паста", /паст/i],
	["тортилья", "тортилья", /тортиль/i],
	["апельсины", "апельсины", /апельсин/i],
	["шоколад тёмный", "шоколад темный", /шоколад/i],
	["помидоры", "помидоры", /помидор/i],
	["томатная паста", "томатная паста", /паст/i],
	["фасоль в банке", "фасоль консервированная", /фасол/i],
	["свинина", "свинина", /свинин/i],
	["говядина", "говядина", /говядин/i],
	["хлеб ржаной", "хлеб ржаной", /хлеб/i],
	["брокколи", "брокколи", /брокколи/i],
	["клубника замороженная", "клубника замороженная", /клубник/i],
	["кола без сахара", "кола без сахара", /кола|cola/i],
	["доместос", "доместос", /доместос/i],
	["творог", "творог", /творог/i],
	["бумажные полотенца", "бумажные полотенца", /полотенц/i],
	["курага", "курага", /кураг/i],
	["миндаль", "миндаль", /миндал/i],
	["шампиньоны", "шампиньоны", /шампиньон/i],
	["соевый соус", "соевый соус", /соев/i],
];

const args = process.argv.slice(2);
const value = (n, d) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : d);
const outPath = value("--out", "/tmp/yarche-prices.json");

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

async function dismissCaptcha() {
	const modal = page.locator('[role="dialog"]:has-text("пройдите проверку")');
	if ((await modal.count()) > 0) {
		const close = page.locator('[role="dialog"] button[aria-label*="акрыть"], [role="dialog"] button:has-text("×")').last();
		await close.click({ timeout: 5000 }).catch(() => {});
		await page.waitForTimeout(1500);
		return true;
	}
	return false;
}

const out = [];
for (const [i, [label, query, re]] of items.entries()) {
	await page.goto(`${BASE}/search?query=${encodeURIComponent(query)}`, { timeout: 60_000, waitUntil: "domcontentloaded" }).catch(() => {});
	await page.waitForTimeout(3500);
	await dismissCaptcha();
	const cards = await page.evaluate(() =>
		[...document.querySelectorAll('[class*="product-card-template"]')].map((card) => {
			const text = (card.innerText || "").replace(/\s+/g, " ").trim();
			const price = text.match(/(\d[\d\s]*,\d{2})\s*₽/)?.[1] ?? "";
			const parts = text.split(/\s*(\d[\d\s]*,\d{2})\s*₽\s*/);
			const name = (parts.slice(2).find((p) => /[А-Яа-яA-Za-z]{3}/.test(p)) ?? "").replace(/\s+/g, " ").trim();
			const button = [...card.querySelectorAll("button")].find((b) => /В корзину|Уведомить/.test(b.innerText));
			return { name: name.slice(0, 120), price, available: /В корзину/.test(button?.innerText ?? "") };
		}),
	);
	const good = cards.filter((c) => c.price && re.test(c.name) && c.available).slice(0, 3);
	out.push({ label, query, found: good, cardsSeen: cards.length });
	console.log(`${i + 1}/${items.length} ${label}: ${good.map((g) => `${g.name} — ${g.price}`).join(" | ") || "нет подходящих"} (${cards.length} карточек)`);
	writeFileSync(outPath, JSON.stringify(out, null, 1));
	await page.waitForTimeout(900);
}
await context.close();
console.log(`\nJSON: ${outPath}`);
