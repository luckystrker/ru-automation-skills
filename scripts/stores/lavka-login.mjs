#!/usr/bin/env node
/**
 * lavka-login.mjs — вход в Яндекс-паспорт для Лавки: телефон → СМС-код → сессия в профиле.
 *
 * Код кладётся в /tmp/lavka-code.txt (одной строкой). Прогресс — в /tmp/lavka-login.log.
 * Запуск (в фоне):
 *   DISPLAY=:95 nohup node stores/lavka-login.mjs > /tmp/lavka-login.log 2>&1 &
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadStoreEnv, proxyFor } from "./proxy.mjs";
import { loadPlaywright } from "./playwright.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const env = loadStoreEnv();
const PHONE = process.env.LAVKA_PHONE ?? ""; // телефон передаётся снаружи: LAVKA_PHONE
if (PHONE === "") {
	console.error("нужен телефон: LAVKA_PHONE=79001234567");
	process.exit(2);
}
const CODE_FILE = "/tmp/lavka-code.txt";
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

/** Капча SmartCaptcha: жмём чекбокс, ждём уход со showcaptcha. */
async function passCaptcha(tag) {
	if (!page.url().includes("showcaptcha") && (await page.locator("text=Я не робот").count()) === 0) return false;
	log(`[${tag}] капча — жму чекбокс`);
	await shot(`lavka-login-${tag}-captcha.png`);
	await page.locator('[class*="Checkbox"]').first().click({ timeout: 8000 }).catch(() => {});
	for (let i = 0; i < 20; i++) {
		await sleep(1000);
		if (!page.url().includes("showcaptcha")) break;
	}
	log(`[${tag}] после капчи: ${page.url().slice(0, 80)}`);
	return true;
}

try {
	await page.goto(`https://passport.yandex.ru/auth?retpath=${encodeURIComponent("https://lavka.yandex.ru/")}`, { timeout: 90_000, waitUntil: "domcontentloaded" });
	await sleep(5000);
	log("паспорт открыт:", page.url().slice(0, 90));
	await passCaptcha("start");
	await shot("lavka-login-01-start.png");

	// телефон
	const phoneInput = page.locator('input[type="tel"], input[name="login"], input[inputmode="tel"], #passp-field-phone').first();
	if ((await phoneInput.count()) === 0) {
		log("поля телефона нет — стоп, смотри скриншот 01-start");
		await context.close();
		process.exit(3);
	}
	await phoneInput.fill(PHONE);
	log("телефон введён");
	await shot("lavka-login-02-phone.png");
	const submit = page.locator('button:has-text("Войти"), button:has-text("Продолжить"), button:has-text("Далее"), button[type="submit"]').first();
	const clicked = await submit.click({ timeout: 10_000 }).then(() => true).catch(() => false);
	if (!clicked) {
		log("кнопка не нашлась — жму Enter в поле телефона");
		await phoneInput.press("Enter").catch(() => {});
	}
	await sleep(7000);
	await passCaptcha("after-phone");
	await shot("lavka-login-03-after-phone.png");
	log("после телефона:", page.url().slice(0, 90));

	// экран кода: ищем поле ввода
	const codeSelectors = ['input[name="code"]', "#passp-field-code", 'input[autocomplete="one-time-code"]', 'input[inputmode="numeric"]', 'input[type="text"]'];
	let codeInput;
	for (let i = 0; i < 30 && !codeInput; i++) {
		for (const selector of codeSelectors) {
			const locator = page.locator(selector).first();
			if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) { codeInput = locator; break; }
		}
		if (!codeInput) await sleep(500);
	}
	if (codeInput === undefined) {
		log("поля для кода не вижу — смотри скриншот 03-after-phone (пароль? выбор способа?)");
		await context.close();
		process.exit(3);
	}
	log("экран кода. ЖДУ ФАЙЛ /tmp/lavka-code.txt (до 12 минут)");
	await shot("lavka-login-04-sms-wait.png");

	let code = "";
	const deadline = Date.now() + 12 * 60 * 1000;
	while (Date.now() < deadline) {
		if (existsSync(CODE_FILE)) {
			code = readFileSync(CODE_FILE, "utf8").replace(/\D/gu, "").slice(0, 8);
			if (code.length >= 4) break;
		}
		await sleep(2500);
	}
	if (code === "") {
		log("код так и не пришёл в файл — стоп");
		await context.close();
		process.exit(4);
	}
	log(`код получен (${code.length} цифр) — ввожу`);
	await codeInput.fill(code).catch(async (error) => {
		log("fill кода не сработал, пробую посимвольно:", String(error?.message ?? error).slice(0, 100));
		await codeInput.click().catch(() => {});
		await page.keyboard.type(code, { delay: 120 });
	});
	await sleep(2500);
	await page.locator('button:has-text("Войти"), button:has-text("Продолжить"), button:has-text("Подтвердить"), button[type="submit"]').first().click({ timeout: 4000 }).catch(() => {});

	// дальше — многошагово: лавка (успех), экран «имя+фамилия» (fln), что-то иное (стоп)
	let nameParts = (process.env.LAVKA_NAME ?? "").trim() === "" ? [] : (process.env.LAVKA_NAME ?? "").trim().split(/\s+/u);
	for (let i = 0; i < 90; i++) {
		await sleep(1000);
		const url = page.url();
		if (url.includes("lavka.yandex.ru") && !url.includes("passport")) break;
		if (url.includes("/fln")) break;
	}
	log("после кода:", page.url().slice(0, 110));

	if (page.url().includes("/fln")) {
		if (nameParts.length === 0) {
			log("шаг имя+фамилия — ЖДУ /tmp/lavka-name.txt (до 8 минут)");
			await shot("lavka-login-06-fln.png");
			const deadline2 = Date.now() + 8 * 60 * 1000;
			while (Date.now() < deadline2) {
				if (existsSync("/tmp/lavka-name.txt")) {
					const raw = readFileSync("/tmp/lavka-name.txt", "utf8").replace(/\s+/gu, " ").trim();
					if (raw !== "") { nameParts = raw.split(/\s+/u); break; }
				}
				await sleep(2500);
			}
		}
		if (nameParts.length === 0) {
			log("имя-фамилия так и не пришли — стоп");
			await shot("lavka-login-06-fln.png");
			await context.close();
			process.exit(5);
		}
		const inputs = page.locator("input:visible");
		const count = await inputs.count();
		log(`fln: полей ${count}, ввожу «${nameParts.join(" ")}»`);
		if (count >= 2) { await inputs.nth(0).fill(nameParts[0]); await inputs.nth(1).fill(nameParts[1] ?? ""); }
		else if (count === 1) { await inputs.nth(0).fill(nameParts.join(" ")); }
		await shot("lavka-login-07-fln-filled.png");
		await page.locator('button:has-text("Далее"), button:has-text("Продолжить"), button:has-text("Войти"), button[type="submit"]').first().click({ timeout: 8000 }).catch(() => {});
		for (let i = 0; i < 40; i++) {
			await sleep(1000);
			if (page.url().includes("lavka.yandex.ru") && !page.url().includes("passport")) break;
		}
	}

	// шаг «выберите аккаунт»: на номере несколько Яндекс-ID
	if (page.url().includes("/auth/suggest")) {
		const wanted = (process.env.LAVKA_LOGIN ?? "").trim() || (existsSync("/tmp/lavka-login.txt") ? readFileSync("/tmp/lavka-login.txt", "utf8").replace(/\s+/gu, " ").trim() : "");
		log("шаг выбора аккаунта, цель:", wanted || "(не задана)");
		await shot("lavka-login-08-suggest.png");
		if (wanted !== "") {
			const clicked = await page.locator(`text=${wanted}`).first().click({ timeout: 8000 }).then(() => true).catch(() => false);
			log(clicked ? `кликнула «${wanted}»` : `не нашла «${wanted}» для клика`);
			await sleep(6000);
			await shot("lavka-login-09-after-account.png");
			log("после выбора аккаунта:", page.url().slice(0, 110));
			for (let i = 0; i < 40; i++) {
				await sleep(1000);
				if (page.url().includes("lavka.yandex.ru") && !page.url().includes("passport")) break;
			}
		}
	}

	log("итог:", page.url().slice(0, 110));
	const bodyText = (await page.evaluate(() => document.body?.innerText ?? "")).replace(/\s+/gu, " ").slice(0, 200);
	log("текст:", bodyText);
	await shot("lavka-login-05-result.png");
	log("готово");
} catch (error) {
	log("ошибка:", String(error?.message ?? error).slice(0, 300));
	await shot("lavka-login-error.png");
}
await context.close();
