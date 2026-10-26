#!/usr/bin/env node
/**
 * yarche.mjs — автоматизация «Ярче+» (yarcheplus.ru) через браузер и российский прокси.
 *
 * Команды:
 *   node stores/yarche.mjs search "молоко" [--limit 10] [--json]
 *   node stores/yarche.mjs add "молоко" --index 1 [--qty 2]
 *   node stores/yarche.mjs cart [--json]
 *   node stores/yarche.mjs address "<город, улица, дом>"   # требует работающих Яндекс.Карт
 *   node stores/yarche.mjs login 79991234567                             # вход по SMS (код вводит человек)
 *
 * Флаги: --profile (постоянный профиль браузера: логин, адрес, корзина живут между запусками),
 *        --headed (видимый браузер под xvfb), --screenshot <путь>.
 *
 * Прокси берётся из stores/proxy.env (BROWSER_PROXY).
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadStoreEnv, profileDir, proxyFor } from "./proxy.mjs";
import { loadPlaywright } from "./playwright.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = "https://yarcheplus.ru";

const args = process.argv.slice(2);
const command = args[0] ?? "help";
const flags = new Set(args.filter((a) => a.startsWith("--")));
const value = (name) => {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
};
const positional = args.slice(1).filter((a) => !a.startsWith("--") && a !== value("--index") && a !== value("--qty") && a !== value("--limit") && a !== value("--screenshot"));

const env = loadStoreEnv();
const headed = flags.has("--headed");
const persistent = flags.has("--profile");
const limit = Number(value("--limit") ?? 10);

async function withPage(handler) {
	const { chromium } = await loadPlaywright();
	const launch = { headless: !headed, args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"], proxy: proxyFor(env) };
	const context = persistent
		? await chromium.launchPersistentContext(profileDir(env), { ...launch, locale: "ru-RU", timezoneId: "Asia/Novosibirsk", viewport: { width: 1400, height: 1000 } })
		: await (await chromium.launch(launch)).newContext({ locale: "ru-RU", timezoneId: "Asia/Novosibirsk", viewport: { width: 1400, height: 1000 } });
	const page = context.pages()[0] ?? (await context.newPage());
	const shots = [];
	page.on("requestfailed", (r) => shots.push(r.url()));
	const result = await handler(page, context);
	if (flags.has("--screenshot")) {
		const path = value("--screenshot") ?? join(HERE, "screenshots", "yarche.png");
		mkdirSync(dirname(path), { recursive: true });
		await page.screenshot({ path });
	}
	await context.close();
	return result;
}

/** Карточки товаров со страницы поиска. */
async function readProducts(page) {
	return page.evaluate(() => {
		const out = [];
		const cards = [...document.querySelectorAll('[class*="product-card-template"]')];
		cards.forEach((card, index) => {
			const text = (card.innerText || "").replace(/\s+/g, " ").trim();
			const price = text.match(/(\d[\d\s]*,\d{2})\s*₽/)?.[1] ?? "";
			const name = text.replace(/^\d[\d\s]*,\d{2}\s*₽\s*/, "").replace(/\s*\d+\s*(г|кг|мл|л)\s*/, " ").replace(/В корзину|Уведомить|\d,\d/g, "").trim();
			const button = [...card.querySelectorAll("button")].find((b) => /В корзину|Уведомить/.test(b.innerText));
			out.push({ index: index + 1, name: name.slice(0, 90), price, available: button?.innerText === "В корзину" });
		});
		return out;
	});
}

async function search(page, query) {
	await page.goto(`${BASE}/search?query=${encodeURIComponent(query)}`, { timeout: 60_000, waitUntil: "domcontentloaded" });
	await page.waitForTimeout(5000);
	const products = await readProducts(page);
	return products.slice(0, limit);
}

async function addToCart(page, query, index, qty) {
	await page.goto(`${BASE}/search?query=${encodeURIComponent(query)}`, { timeout: 60_000, waitUntil: "domcontentloaded" });
	await page.waitForTimeout(5000);
	const buttons = page.locator('button:has-text("В корзину")');
	const count = await buttons.count();
	if (count === 0) return { ok: false, reason: "нет товаров с кнопкой «В корзину» на этой странице" };
	const target = buttons.nth(Math.max(0, (index ?? 1) - 1));
	await target.click({ timeout: 15_000 }).catch((error) => ({ clickError: error.message }));
	await page.waitForTimeout(3000);

	// модалка адреса: либо «Указать позже», либо сообщение, что без адреса нельзя
	const modal = page.locator('[role="dialog"]:has-text("Укажите адрес")');
	let modalText = "";
	if (await modal.count() > 0) {
		modalText = (await modal.first().innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
		const later = page.locator('button:has-text("Указать позже")');
		if (await later.count() > 0) {
			await later.first().click().catch(() => {});
			await page.waitForTimeout(2500);
		}
	}
	// проверяем, изменилась ли кнопка (значит товар лёг в корзину)
	const state = await page.evaluate(() => {
		const btn = document.querySelector('button[class*="cart"], [class*="counter"]');
		return { counter: btn?.innerText?.trim().slice(0, 20) ?? null, body: document.body.innerText.match(/в корзине[^\n]{0,40}/i)?.[0] ?? null };
	});
	return { ok: true, index, qty: qty ?? 1, addressModal: modalText !== "", modalText, state };
}

async function readCart(page) {
	await page.goto(`${BASE}/`, { timeout: 60_000, waitUntil: "domcontentloaded" });
	await page.waitForTimeout(4000);
	// сумма в шапке (кнопка корзины) — самый надёжный индикатор
	const headerTotal = await page.evaluate(() => {
		const header = document.querySelector("header") ?? document.body;
		const match = (header.innerText || "").match(/(\d[\d\s]*,\d{2})\s*₽/);
		return match?.[1] ?? null;
	});
	// открываем панель корзины кликом по кнопке с суммой
	const cartButton = page.locator('header button:has-text("₽"), header a:has-text("₽")').last();
	if (await cartButton.count() > 0) {
		await cartButton.click({ timeout: 10_000, force: true }).catch(() => {});
		await page.waitForTimeout(4000);
	}
	const panel = await page.evaluate(() => {
		const dialog = document.querySelector('[role="dialog"], [class*="drawer"], [class*="sidebar"]');
		return dialog ? dialog.innerText.replace(/\n{2,}/g, "\n").slice(0, 1500) : null;
	});
	const text = panel ?? (await page.evaluate(() => document.body.innerText));
	const items = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => /₽/.test(line) && line.length > 3)
		.slice(0, 30);
	const total = text.match(/Сумма заказа[^\n]{0,40}|Стоимость товаров[^\n]{0,40}|Итого[^\n]{0,40}/)?.[0] ?? null;
	return { url: page.url(), headerTotal, total, items, panelOpened: panel !== null, empty: /корзина пуста|В корзине пока ничего/i.test(text) };
}

async function main() {
	switch (command) {
		case "search": {
			const query = positional[0];
			if (!query) throw new Error("нужен поисковый запрос");
			const products = await withPage((page) => search(page, query));
			if (flags.has("--json")) console.log(JSON.stringify(products, null, 1));
			else for (const p of products) console.log(`${p.index}. ${p.name} — ${p.price} ₽${p.available ? "" : " (нет в наличии)"}`);
			return 0;
		}
		case "add": {
			const query = positional[0];
			if (!query) throw new Error("нужен поисковый запрос");
			const result = await withPage((page) => addToCart(page, query, Number(value("--index") ?? 1), Number(value("--qty") ?? 1)));
			console.log(JSON.stringify(result, null, 1));
			return result.ok ? 0 : 1;
		}
		case "cart": {
			const result = await withPage((page) => readCart(page));
			console.log(flags.has("--json") ? JSON.stringify(result, null, 1) : `${result.url}\n${result.items.join("\n")}\n${result.total ?? ""}`);
			return 0;
		}
		case "login": {
			const phone = positional[0];
			if (!phone) throw new Error("нужен телефон в формате 79991234567");
			const code = await withPage(async (page) => {
				await page.goto(`${BASE}/`, { timeout: 60_000, waitUntil: "domcontentloaded" });
				await page.waitForTimeout(4000);
				const entry = page.locator('button:has-text("Войти"), a:has-text("Войти")').first();
				await entry.click({ timeout: 15_000 }).catch(() => {});
				await page.waitForTimeout(3000);
				const phoneField = page.locator('input[type="tel"], input[name*="phone"], input[placeholder*="телефон" i]').first();
				await phoneField.fill(phone).catch(() => {});
				await page.locator('button:has-text("Получить код"), button:has-text("Войти"), button[type="submit"]').first().click().catch(() => {});
				await page.waitForTimeout(4000);
				return "код запрошен — введи его в поле на странице (интерактивный режим требует человека)";
			});
			console.log(code);
			return 0;
		}
		default:
			console.log("команды: search | add | cart | login | address\nфлаги: --profile --headed --json --limit N --index N --screenshot PATH");
			return 0;
	}
}

main().then(
	(code) => {
		if (code !== undefined) process.exitCode = code;
	},
	(error) => {
		process.stderr.write(`yarche: ${error?.message ?? error}\n`);
		process.exitCode = 1;
	},
);
