#!/usr/bin/env node
/**
 * lavka-login-continue.mjs — проверить состояние входа: залогинены ли в Лавке и
 * какой шаг ждёт паспорт (после успешного СМС-кода Яндекс спросил имя+фамилию).
 *
 *   systemd-run --user --unit=lavka-continue --setenv=DISPLAY=:95 --working-directory="$PWD" /usr/bin/node stores/lavka-login-continue.mjs
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadStoreEnv, proxyFor } from "./proxy.mjs";
import { loadPlaywright } from "./playwright.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const env = loadStoreEnv();
const shotDir = join(HERE, "screenshots");
mkdirSync(shotDir, { recursive: true });
const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
const shot = (name) => page.screenshot({ path: join(shotDir, name) }).catch(() => {});

// капча?
async function passCaptcha() {
	if (!page.url().includes("showcaptcha")) return;
	log("капча — жму чекбокс");
	await page.locator('[class*="Checkbox"]').first().click({ timeout: 8000 }).catch(() => {});
	for (let i = 0; i < 15; i++) { await sleep(1000); if (!page.url().includes("showcaptcha")) break; }
}

try {
	await page.goto("https://lavka.yandex.ru/", { timeout: 90_000, waitUntil: "domcontentloaded" });
	await sleep(6000);
	await passCaptcha();
	const lavkaState = await page.evaluate(() => {
		const text = (document.body?.innerText ?? "").replace(/\s+/gu, " ");
		return { login: /Войти/u.test(text), head: text.slice(0, 220) };
	});
	log("лавка url:", page.url().slice(0, 90));
	log("лавка: кнопка «Войти» на месте?", lavkaState.login);
	log("лавка текст:", lavkaState.head);
	await shot("lavka-state-01-lavka.png");

	await page.goto(`https://passport.yandex.ru/pwl-yandex/auth/add?retpath=${encodeURIComponent("https://lavka.yandex.ru/")}`, { timeout: 90_000, waitUntil: "domcontentloaded" });
	await sleep(6000);
	await passCaptcha();
	const passState = await page.evaluate(() => ({
		text: (document.body?.innerText ?? "").replace(/\s+/gu, " ").slice(0, 300),
	}));
	log("паспорт url:", page.url().slice(0, 110));
	log("паспорт текст:", passState.text);
	await shot("lavka-state-02-passport.png");
} catch (error) {
	log("ошибка:", String(error?.message ?? error).slice(0, 300));
	await shot("lavka-state-error.png");
}
await context.close();
log("готово");
