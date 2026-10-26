#!/usr/bin/env node
/**
 * Проверка прокси и магазинов: каким IP нас видит интернет, пускают ли магазины
 * и не подсовывают ли антибот-заглушку. Делает скриншоты в stores/screenshots/.
 *
 * Запуск:
 *   node stores/verify-proxy.mjs                 # как настроено в proxy.env
 *   node stores/verify-proxy.mjs --no-proxy      # принудительно напрямую
 *   node stores/verify-proxy.mjs --store 5ka.ru  # только один магазин
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadStoreEnv, proxyFor } from "./proxy.mjs";
import { loadPlaywright } from "./playwright.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, "screenshots");

const STORES = [
	["5ka.ru", "https://5ka.ru/"],
	["lenta.com", "https://lenta.com/"],
	["chizhik.club", "https://chizhik.club/"],
	["magnit.ru", "https://magnit.ru/"],
	["yarcheplus.ru", "https://yarcheplus.ru/"],
	["kuper.ru", "https://kuper.ru/"],
	["perekrestok.ru", "https://www.perekrestok.ru/"],
];

const args = process.argv.slice(2);
const noProxy = args.includes("--no-proxy");
const headed = args.includes("--headed");
const storeIndex = args.indexOf("--store");
const only = storeIndex >= 0 ? args[storeIndex + 1] : undefined;

const env = loadStoreEnv();
const proxy = noProxy ? undefined : proxyFor(env);
const { chromium } = await loadPlaywright();

console.log(`прокси: ${proxy ? proxy.server : "нет (идём напрямую с нашего IP)"}, режим: ${headed ? "видимый браузер (xvfb)" : "headless"}`);
const browser = await chromium.launch({
	headless: !headed,
	args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
	...(proxy === undefined ? {} : { proxy }),
});
const context = await browser.newContext({
	locale: "ru-RU",
	timezoneId: "Asia/Novosibirsk",
	viewport: { width: 1280, height: 900 },
	userAgent:
		"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
});

// 1) кто мы для интернета
try {
	const page = await context.newPage();
	await page.goto("https://api.country.is/", { timeout: 30_000 });
	const info = JSON.parse(await page.locator("body").innerText());
	console.log(`внешний IP: ${info.ip}, страна: ${info.country}`);
	await page.close();
} catch (error) {
	console.log(`не смог определить внешний IP: ${error?.message ?? error}`);
}

// 2) магазины
mkdirSync(SHOTS, { recursive: true });
const challengeMarkers = /(sp_|X-SP-|servicepipe|qrator|captcha|подтвердите, что вы не робот|проверка браузера|challenge)/i;
for (const [name, url] of STORES) {
	if (only !== undefined && !name.includes(only)) continue;
	const page = await context.newPage();
	const started = Date.now();
	try {
		const response = await page.goto(url, { timeout: 45_000, waitUntil: "domcontentloaded" });
		// даём JS-челленджу (QRATOR / ServicePipe) время отработать
		await page.waitForTimeout(headed ? 12_000 : 5_000);
		const title = (await page.title()).slice(0, 60);
		const html = (await page.content()).slice(0, 200_000);
		const challenge = challengeMarkers.test(html) ? "ЕСТЬ признаки антибота/капчи" : "признаков антибота не видно";
		const file = join(SHOTS, `${name.replace(/[^\w.-]/g, "_")}.png`);
		await page.screenshot({ path: file, fullPage: false });
		console.log(`${name}: HTTP ${response?.status() ?? "?"}, ${Date.now() - started} мс, title="${title}", ${challenge}, скриншот ${file}`);
	} catch (error) {
		console.log(`${name}: ОШИБКА ${error?.message ?? error}`);
	} finally {
		await page.close();
	}
}

await browser.close();
