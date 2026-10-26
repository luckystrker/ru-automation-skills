#!/usr/bin/env node
/**
 * yarche-fill-cart.mjs — наполнить корзину «Ярче+» по списку с фильтрами релевантности.
 * Требует залогиненного профиля браузера (stores/browser-profile).
 *
 * node stores/yarche-fill-cart.mjs [--dry] [--only "молоко"]
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { loadStoreEnv, profileDir, proxyFor } from "./proxy.mjs";
import { loadPlaywright } from "./playwright.mjs";

const BASE = "https://yarcheplus.ru";
const LOG = "/tmp/yarche-fill-cart.log";
const log = (line) => {
	appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
	process.stdout.write(`${line}\n`);
};

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const only = args.indexOf("--only") >= 0 ? args[args.indexOf("--only") + 1] : null;

// [что нужно, поисковый запрос, обязательный regex в названии, антивыбор]
const items = [
	["бумага туалетная", "туалетная бумага", /бумаг/i, /влажн/i],
	["молоко", "молоко 2,5% пастеризованное", /молок/i, /сгущ|сух|соев|овсян|кокос|миндальн|топлен|cливк/i],
	["картошка", "картофель", /картоф/i, /чипс|сырок|пюре|фри|по-деревенски|батат/i],
	["курица целиком", "тушка цыпленка", /тушк|цыплен|куриц/i, /отбивн|пюре|фарш|филе|грудк|бедр|голен|крыл|наггетс|котлет/i],
	["морковь", "морковь", /морков/i, /по-корейски|сок|нектар/i],
	["яблоки", "яблоки", /яблок/i, /сок|пюре|чипс|смузи/i],
	["ветчина из индейки", "ветчина из индейки", /ветчин/i, /куриц|свин|говяд/i],
	["зубная паста", "зубная паста Labori", /паста/i, /макарон|grand di|соус/i],
	["тортилья", "тортилья", /тортиль|лепеш/i, /чипс/i],
	["апельсины", "апельсины", /апельсин/i, /сок|нектар|шоколад|мармелад|конфет/i],
	["шоколад тёмный", "шоколад горький", /шоколад/i, /молочн|батончик|конфет|печень/i],
	["помидоры", "томаты свежие", /томат|помидор/i, /паст|соус|кетчуп|резан|консерв|вялен/i],
	["томатная паста", "томатная паста", /паст/i, /зубн/i],
	["фасоль в банке", "фасоль консервированная", /фасол/i, /стручков|заморож/i],
	["свинина", "свинина", /свинин/i, /тушен|деликатес|пельмен|колбас|сосиск/i],
	["говядина", "говядина", /говядин/i, /тушен|пельмен|колбас|сосиск|фарш/i],
	["хлеб ржаной", "хлеб ржаной", /хлеб/i, /хлебц|сухар|батон|булк/i],
	["брокколи", "капуста брокколи", /брокколи/i, /котлет|медальон|наггетс/i],
	["клубника замороженная", "клубника замороженная", /клубник/i, /йогурт|морс|варень|джем/i],
	["кола без сахара", "кола без сахара", /кола|cola/i, /карамель|леденц|жевательн/i],
	["доместос", "доместос", /доместос|dos-gel/i, null],
	["творог", "творог", /творог/i, /сырок|масс|запеканк|изделье/i],
	["бумажные полотенца", "бумажные полотенца", /полотенц/i, null],
	["курага", "курага", /кураг/i, /конфет|глазур/i],
	["миндаль", "миндаль", /миндал/i, /конфет|печень|шоколад/i],
	["шампиньоны", "шампиньоны", /шампиньон/i, /суп|соус/i],
	["соевый соус", "соевый соус", /соев/i, /салат|лапш|приправ/i],
];

const env = loadStoreEnv();
const { chromium } = await loadPlaywright();
const context = await chromium.launchPersistentContext(profileDir(env), {
	headless: false,
	args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
	proxy: proxyFor(env),
	locale: "ru-RU",
	timezoneId: "Asia/Novosibirsk",
	viewport: { width: 1400, height: 1000 },
});
const page = context.pages()[0] ?? (await context.newPage());
const results = [];
const save = () => writeFileSync("/tmp/yarche-fill-cart.json", JSON.stringify({ at: new Date().toISOString(), results }, null, 1));

async function readCards() {
	return page.evaluate(() =>
		[...document.querySelectorAll('[class*="product-card-template"]')].map((card, i) => {
			const text = (card.innerText || "").replace(/\s+/g, " ").trim();
			const price = text.match(/(\d[\d\s]*,\d{2})\s*₽/)?.[1] ?? "";
			const button = [...card.querySelectorAll("button")].find((b) => /В корзину|Уведомить/.test(b.innerText));
			return { i, text: text.slice(0, 160), price, available: /В корзину/.test(button?.innerText ?? "") };
		}),
	);
}

for (const [i, [label, query, re, anti]] of items.entries()) {
	if (only && !label.includes(only)) continue;
	try {
		await page.goto(`${BASE}/search?query=${encodeURIComponent(query)}`, { timeout: 60_000, waitUntil: "domcontentloaded" });
		await page.waitForTimeout(4000);
		const cards = await readCards();
		const pick = cards.find((c) => c.available && re.test(c.text) && !(anti && anti.test(c.text)));
		if (!pick) {
			results.push({ label, query, ok: false, reason: "нет подходящей карточки", sample: cards.slice(0, 2).map((c) => c.text) });
			log(`${i + 1}/${items.length} ${label}: НЕ НАШЛА`);
			save();
			continue;
		}
		const card = page.locator('[class*="product-card-template"]').nth(pick.i);
		const nameParts = pick.text.split(/\d[\d\s]*,\d{2}\s*₽/);
		const title = (nameParts.length > 1 ? nameParts[1] : pick.text).replace(/В корзину|Уведомить|[Хх]ит|новое|\d(?:[.,]\d)?/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, 110);
		if (dry) {
			results.push({ label, query, ok: true, dry: true, picked: title, price: pick.price });
			log(`${i + 1}/${items.length} [dry] ${label} → ${title} — ${pick.price} ₽`);
			save();
			continue;
		}
		await card.locator('button:has-text("В корзину")').first().scrollIntoViewIfNeeded().catch(() => {});
		await card.locator('button:has-text("В корзину")').first().click({ timeout: 12_000 }).catch((e) => log(`клик: ${e.message.slice(0, 60)}`));
		await page.waitForTimeout(2500);

		// капча/модалка адреса
		const captcha = await page.evaluate(() => /пройдите проверку/i.test(document.body.innerText));
		const after = await card.innerText().catch(() => "");
		const inCart = /Удалить|−|-|1\s*шт/i.test(after) && !/В корзину/.test(after);
		results.push({ label, query, ok: true, picked: title, price: pick.price, inCart, captcha });
		log(`${i + 1}/${items.length} ${label} → ${title} — ${pick.price} ₽ ${inCart ? "✓ в корзине" : "? не подтвердилось"}${captcha ? " ⚠ КАПЧА" : ""}`);
		save();
		if (captcha) {
			log("капча — останавливаюсь, чтобы не долбить сайт");
			await page.screenshot({ path: "/tmp/yarche-captcha-fill.png" });
			break;
		}
		await page.waitForTimeout(1200);
	} catch (error) {
		results.push({ label, query, ok: false, reason: `${error?.message ?? error}`.slice(0, 160) });
		log(`${i + 1}/${items.length} ${label}: ОШИБКА ${String(error?.message ?? error).slice(0, 100)}`);
		save();
	}
}

await page.goto(`${BASE}/cart`, { timeout: 60_000, waitUntil: "domcontentloaded" }).catch(() => {});
await page.waitForTimeout(5000);
const cartText = await page.evaluate(() => (document.body.innerText || "").replace(/\n{2,}/g, "\n"));
writeFileSync("/tmp/yarche-cart-final.txt", cartText);
await page.screenshot({ path: "/tmp/yarche-cart-final.png", fullPage: false });
log(`итог корзины сохранён: /tmp/yarche-cart-final.txt (${cartText.length} символов)`);
console.log("\n=== КОРЗИНА ===");
console.log(cartText.split("\n").filter((l) => l.trim()).slice(0, 80).join("\n"));
await context.close();
save();
