#!/usr/bin/env node
/**
 * magnit-fill.mjs — собрать корзину «Магнита» по списку через внутренний API.
 *
 * Требует живую сессию в профиле `stores/browser-profile-magnit` (см. stores/magnit-login.mjs):
 * скрипт открывает браузер под xvfb, берёт оттуда куки авторизации и работает с API.
 *
 *   node tools/magnit-fill.mjs --store <код> --items "молоко,хлеб ржаной,творог"
 *   node tools/magnit-fill.mjs --store <код> --list list.json [--dry] [--json]
 *
 * --store   код магазина (обязателен; или переменная MAGNIT_STORE)
 * --items   список через запятую
 * --list    JSON-массив строк или объектов {query, qty}
 * --dry     только подобрать товары и показать цены, корзину не трогать
 *
 * Ответ API: цены в копейках. Корзина живёт на сервере под storeCode и видна в приложении
 * с тем же магазином; сайт в браузере может показывать другой магазин (из серверного SSR).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "../stores/playwright.mjs";

const { chromium } = await loadPlaywright();

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILE = process.env.MAGNIT_PROFILE ?? join(HERE, "..", "stores", "browser-profile-magnit");
const PROXY = process.env.MAGNIT_PROXY ?? "socks5://127.0.0.1:8890";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const APP_VERSION = process.env.MAGNIT_APP_VERSION ?? "2026.10.21-11.6";

const args = process.argv.slice(2);
const value = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const store = value("store", process.env.MAGNIT_STORE ?? "");
if (store === "") {
	process.stderr.write("нужен магазин: --store <код> или MAGNIT_STORE\n");
	process.exit(1);
}
// x-service: сайт и приложение-доставка используют "dostavka"; "express" — отдельная корзина.
const service = value("service", process.env.MAGNIT_SERVICE ?? "dostavka");
const dry = has("dry");
const asJson = has("json");

let items = [];
const listPath = value("list");
if (listPath !== undefined) {
	const raw = JSON.parse(readFileSync(listPath, "utf8"));
	items = raw.map((e) => (typeof e === "string" ? { query: e, qty: 1 } : { qty: 1, ...e }));
} else if (value("items") !== undefined) {
	items = String(value("items"))
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
		.map((query) => ({ query, qty: 1 }));
}
if (items.length === 0) {
	process.stderr.write("нужен список: --items \"молоко,хлеб\" или --list file.json\n");
	process.exit(1);
}

const ctx = await chromium.launchPersistentContext(PROFILE, {
	headless: false,
	args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
	proxy: { server: PROXY },
	locale: "ru-RU",
	timezoneId: "Asia/Novosibirsk",
	viewport: { width: 1400, height: 1000 },
	userAgent: UA,
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto("https://magnit.ru/", { waitUntil: "domcontentloaded", timeout: 90_000 });
await page.waitForTimeout(6000);

const session = await page.evaluate(async () => {
	const r = await fetch("/_auth/session", { headers: { "x-magnit-bff": "1" } }).catch(() => null);
	return r === null ? null : await r.json().catch(() => null);
});
if (session?.authorized !== true) {
	process.stderr.write("сессия не авторизована — сначала stores/magnit-login.mjs\n");
	await ctx.close();
	process.exit(2);
}

const result = await page.evaluate(
	async ({ store, items, dry, appVersion, service }) => {
		// Корзина привязана к паре «устройство + магазин»: device id сайта живёт в cookie mg_ksid.
		const cookieMatch = document.cookie.match(/mg_ksid=([^;]+)/);
		const deviceId = cookieMatch ? decodeURIComponent(cookieMatch[1]) : crypto.randomUUID();
		const headers = {
			"x-magnit-bff": "1",
			"x-client-name": "magnit",
			"x-service": service,
			accept: "application/json",
			"x-device-id": deviceId,
			"x-app-version": appVersion,
			"x-device-platform": "Web",
			"content-type": "application/json",
		};
		const picked = [];
		const missed = [];
		for (const item of items) {
			const response = await fetch("/webgate/v2/goods/search", {
				method: "POST",
				headers,
				credentials: "include",
				body: JSON.stringify({
					includeAdultGoods: true,
					pagination: { offset: 0, limit: 5 },
					sort: { order: "desc", type: "popularity" },
					term: item.query,
					storeCode: store,
					storeType: "dostavka",
					catalogType: "3",
				}),
			});
			const data = await response.json().catch(() => null);
			const goods = (data?.items ?? []).filter((g) => Number(g.price) > 0);
			if (goods.length === 0) {
				missed.push(item.query);
				continue;
			}
			const good = goods[0];
			picked.push({ label: item.query, id: String(good.id), name: good.name, price: Number(good.price), qty: item.qty ?? 1 });
			await new Promise((r) => setTimeout(r, 300));
		}
		if (dry || picked.length === 0) return { picked, missed, cart: null };
		const url = `/webgate/v1/carts/lite?storeCode=${store}&storeType=dostavka`;
		const put = await fetch(url, {
			method: "PUT",
			headers,
			credentials: "include",
			body: JSON.stringify({ items: picked.map((p) => ({ goodId: p.id, offerId: p.id, qnty: p.qty })) }),
		});
		const putBody = await put.text();
		const get = await fetch(url, { headers, credentials: "include" });
		const cart = await get.json().catch(() => null);
		return { picked, missed, deviceId, cart: { status: put.status, body: putBody.slice(0, 160), count: cart?.totalGoodsCount ?? null, id: cart?.id ?? null } };
	},
	{ store, items, dry, appVersion: APP_VERSION, service },
);

const rub = (cents) => (cents / 100).toFixed(2);
const total = result.picked.reduce((sum, p) => sum + p.price, 0);

if (asJson) {
	process.stdout.write(`${JSON.stringify({ store, dry, picked: result.picked, missed: result.missed, total: rub(total), cart: result.cart }, null, 1)}\n`);
} else {
	process.stdout.write(`магазин ${store} (${service}): подобрано ${result.picked.length} из ${items.length}\n`);
	for (const p of result.picked) process.stdout.write(`  ${rub(p.price)} ₽ × ${p.qty}  ${p.name.slice(0, 80)}\n`);
	if (result.missed.length > 0) process.stdout.write(`не нашлось: ${result.missed.join(", ")}\n`);
	process.stdout.write(`итого: ${rub(total)} ₽${result.cart ? ` | корзина: ${result.cart.count} шт (${result.cart.status}), device ${result.deviceId?.slice(0, 18)}…` : " [dry]"}\n`);
}

await ctx.close();
