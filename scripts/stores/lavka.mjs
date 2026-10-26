#!/usr/bin/env node
/**
 * lavka.mjs — Яндекс Лавка из залогиненного браузера: адреса, поиск, корзина.
 *
 * Механика (по рецепту проекта osinara, пути из yandex-lavka-mcp):
 * приватное веб-API lavka.yandex.ru/api/v1/* дёргается site-ным fetch'ем
 * из вкладки — сессия в куках профиля browser-profile-lavka, CSRF со страницы.
 *
 * Команды:
 *   node stores/lavka.mjs probe            # адреса + корзина + поиск «молоко» (без изменений)
 *   node stores/lavka.mjs search "молоко"  # только поиск
 *   node stores/lavka.mjs cart             # показать корзину
 *   node stores/lavka.mjs demo             # собрать демо-корзину: молоко, хлеб, яйца
 *   node stores/lavka.mjs screenshot       # скриншот страницы корзины
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadStoreEnv, proxyFor } from "./proxy.mjs";
import { loadPlaywright } from "./playwright.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const env = loadStoreEnv();
const args = process.argv.slice(2);
const command = args[0] ?? "help";
const CITY = process.env.LAVKA_CITY ?? "65"; // код города Яндекс.Карт

const EP = {
	addresses: { method: "POST", path: "/api/v1/providers/address/v1/get-favorite-addresses" },
	cart: { method: "POST", path: "/api/v1/providers/cart/v1/retrieve" },
	cartUpdate: { method: "POST", path: "/api/v1/providers/cart/v1/update" },
	search: { method: "POST", path: "/api/v1/providers/search/v3/lavka" },
};

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(join(HERE, "screenshots"), { recursive: true });

const { chromium } = await loadPlaywright();
const context = await chromium.launchPersistentContext(join(HERE, "browser-profile-lavka"), {
	headless: false,
	args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
	proxy: proxyFor(env),
	locale: "ru-RU",
	timezoneId: "Asia/Novosibirsk",
	viewport: { width: 1400, height: 1000 },
});
const page = context.pages()[0] ?? (await context.newPage());

/** Сайтовый fetch из вкладки: куки и CSRF сами. */
async function api(name, body) {
	const spec = EP[name];
	return page.evaluate(async ({ url, method, body, city }) => {
		const html = document.documentElement.innerHTML;
		const csrf = (html.match(/"csrfToken"\s*:\s*"([^"]+)"/) || [])[1] || "";
		const headers = {
			accept: "application/json",
			"x-requested-with": "XMLHttpRequest",
			"x-lavka-web-locale": "ru-RU",
			"x-lavka-web-city": city,
			"x-captcha-service": "lavka",
			"x-captcha-language": "ru",
		};
		if (csrf) headers["x-csrf-token"] = csrf;
		if (method !== "GET") headers["content-type"] = "application/json";
		try {
			const response = await fetch(url, { method, credentials: "include", headers, body: method === "GET" ? undefined : JSON.stringify(body) });
			const text = await response.text();
			let data = null;
			try { data = JSON.parse(text); } catch { data = null; }
			return { status: response.status, data, raw: data === null ? text.slice(0, 300) : null };
		} catch (error) {
			return { status: 0, data: null, raw: String(error) };
		}
	}, { url: spec.path, method: spec.method, body: body ?? {}, city: CITY });
}

const baseBody = (point) => ({
	additionalData: {},
	currencySign: "₽",
	depotType: "regular",
	...(point ? { position: { location: [point.lon, point.lat] } } : {}),
});

/** Достать адрес доставки из аккаунта (первый сохранённый). */
async function getPoint() {
	const r = await api("addresses", {});
	if (r.status !== 200 || r.data === null) { log("!! адреса не отдались:", r.status, r.raw ?? ""); return undefined; }
	const list = Array.isArray(r.data) ? r.data : Object.values(r.data ?? {});
	for (const entry of list) {
		const a = entry?.address ?? {};
		const loc = Array.isArray(a.location) ? a.location : [];
		if (loc.length === 2) {
			return { label: a.label ?? a.shortAddress ?? `${a.street ?? ""} ${a.house ?? ""}`.trim(), city: a.city, street: a.street, house: a.house, lon: Number(loc[0]), lat: Number(loc[1]) };
		}
	}
	log("!! в аккаунте нет адресов с координатами; список:", JSON.stringify(list).slice(0, 300));
	return undefined;
}

async function readCart(point) {
	const r = await api("cart", baseBody(point));
	if (r.status !== 200 || r.data === null) { log("!! корзина не отдалась:", r.status, r.raw ?? ""); return undefined; }
	const d = r.data?.cart ?? r.data ?? {};
	const items = Array.isArray(d.items) ? d.items : [];
	return {
		cartId: d.cartId, cartVersion: d.cartVersion, deliveryType: d.deliveryType, deliveryTimeInfo: d.deliveryTimeInfo,
		nextIdempotencyToken: d.nextIdempotencyToken,
		total: d.totalPriceValue ?? d.totalPrice ?? null,
		items: items.map((i) => ({ id: i.id, title: i.title ?? i.name, qty: i.quantity, price: i.currentPrice ?? i.price })),
	};
}

function showCart(cart) {
	if (cart === undefined) return;
	log(`Корзина (версия ${cart.cartVersion}):`);
	if (cart.items.length === 0) log("  — пусто —");
	for (const i of cart.items) log(`  • ${i.title} ×${i.qty} — ${i.price ?? "?"} ₽`);
	log(`  Итого: ${cart.total ?? "?"} ₽`);
}

async function addItems(point, wanted) {
	let cart = await readCart(point);
	if (cart === undefined) return undefined;
	for (const query of wanted) {
		log(`\n→ ищу «${query}»...`);
		const s = await api("search", { ...baseBody(point), productsLimit: 12, source: "manual_input", subcategoriesLimit: 0, text: query, useRetail: true });
		if (s.status !== 200) { log("  поиск не сработал:", s.status, s.raw ?? ""); continue; }
		const list = Array.isArray(s.data?.cacheProducts) ? s.data.cacheProducts : [];
		const pick = list.find((p) => p && (p.available ?? p.inStock ?? true) !== false && (p.id ?? p.productId));
		if (!pick) { log("  ничего доступного не нашлось"); continue; }
		const id = pick.id ?? pick.productId;
		const price = pick.currentPrice ?? pick.price;
		const title = pick.title ?? pick.name;
		log(`  беру: ${title} — ${price} ₽`);
		if (cart.items.some((i) => i.id === id)) { log("  (уже в корзине)"); continue; }
		const items = [...cart.items.map((i) => ({ id: i.id, quantity: i.qty, price: i.price })), { id, quantity: 1, price }];
		const body = {
			...baseBody(point), cartId: cart.cartId, cartVersion: cart.cartVersion,
			deliveryTimeInfo: cart.deliveryTimeInfo, deliveryType: cart.deliveryType,
			idempotencyToken: cart.nextIdempotencyToken ?? undefined, isUserOrderEdit: false,
			items: items.map((i) => ({ currency: "RUB", id: i.id, price: i.price === null || i.price === undefined ? "" : String(i.price), pricePerCount: "1", quantity: String(i.quantity), quantityType: "unit", title: "" })),
		};
		const u = await api("cartUpdate", body);
		if (u.status !== 200) { log("  добавление не прошло:", u.status, JSON.stringify(u.data ?? u.raw).slice(0, 200)); continue; }
		cart = await readCart(point);
		log("  в корзине!");
	}
	return cart;
}

try {
	// открываем Лавку и ждём
	await page.goto("https://lavka.yandex.ru/", { timeout: 90_000, waitUntil: "domcontentloaded" });
	await sleep(6000);
	log("страница:", page.url().slice(0, 60), "|", await page.title());

	const point = await getPoint();
	if (point !== undefined) log(`адрес: ${point.label} (${point.lat.toFixed(4)}, ${point.lon.toFixed(4)})`);

	if (command === "probe" || command === "cart") {
		const cart = await readCart(point);
		showCart(cart);
		if (command === "probe") {
			log("\n→ ищу «молоко» (проверка поиска)...");
			const s = await api("search", { ...baseBody(point), productsLimit: 12, source: "manual_input", subcategoriesLimit: 0, text: "молоко", useRetail: true });
			log("  код:", s.status);
			const list = Array.isArray(s.data?.cacheProducts) ? s.data.cacheProducts : [];
			for (const p of list.slice(0, 6)) log(`  • ${p.title ?? p.name} — ${p.currentPrice ?? p.price} ₽`);
		}
	} else if (command === "search") {
		const q = args[1] ?? "молоко";
		const s = await api("search", { ...baseBody(point), productsLimit: 12, source: "manual_input", subcategoriesLimit: 0, text: q, useRetail: true });
		log("код:", s.status);
		const list = Array.isArray(s.data?.cacheProducts) ? s.data.cacheProducts : [];
		for (const p of list) log(`  • ${p.title ?? p.name} — ${p.currentPrice ?? p.price} ₽`);
	} else if (command === "demo") {
		const cart = await addItems(point, ["молоко", "хлеб", "яйца"]);
		showCart(cart);
		// скриншот страницы корзины
		await page.goto("https://lavka.yandex.ru/", { timeout: 90_000, waitUntil: "domcontentloaded" });
		await sleep(4000);
		await page.screenshot({ path: join(HERE, "screenshots", "lavka-cart.png") }).catch(() => {});
		log("скриншот: stores/screenshots/lavka-cart.png");
	} else if (command === "screenshot") {
		await page.screenshot({ path: join(HERE, "screenshots", "lavka-page.png") }).catch(() => {});
		log("скриншот: stores/screenshots/lavka-page.png");
	} else {
		log("команды: probe | search <q> | cart | demo | screenshot");
	}
} catch (error) {
	log("ошибка:", String(error?.message ?? error).slice(0, 300));
}
await context.close();
