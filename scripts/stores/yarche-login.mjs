#!/usr/bin/env node
/**
 * yarche-login.mjs — вход в «Ярче+» по телефону + SMS, с сохранением профиля браузера.
 *
 * Запуск (в фоне):  node stores/yarche-login.mjs <телефон>
 * Скрипт вводит телефон, просит SMS-код и ждёт его в файле /tmp/yarche-code.txt
 * (до 20 минут), после чего вводит код и проверяет, что вход выполнен.
 * Лог: /tmp/yarche-login.log
 */
import { appendFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { loadStoreEnv, profileDir, proxyFor } from "./proxy.mjs";
import { loadPlaywright } from "./playwright.mjs";

const PHONE = (process.argv[2] ?? "").replace(/[^\d]/g, "");
const CODE_FILE = process.env.YARCHE_CODE_FILE ?? "/tmp/yarche-code.txt";
const CAPTCHA_FILE = process.env.YARCHE_CAPTCHA_FILE ?? "/tmp/yarche-captcha.txt";
const CAPTCHA_SHOT = "/tmp/yarche-captcha.png";
const LOG = "/tmp/yarche-login.log";

const log = (line) => {
	const text = `${new Date().toISOString()} ${line}\n`;
	appendFileSync(LOG, text);
	process.stdout.write(text);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Если на странице появилась капча — показываем человеку картинку и ждём текст. */
async function solveCaptchaIfPresent(page, log) {
	const button = page.locator('button:has-text("Отправить")').first();
	const text = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ");
	const looksLikeCaptcha = /картинки|Введите текст|капча/i.test(text) || (await page.locator('iframe[src*="captcha"], [class*="captcha" i]').count()) > 0;
	if (!looksLikeCaptcha) return false;
	await page.locator('[class*="captcha" i], iframe[src*="captcha"]').first().screenshot({ path: CAPTCHA_SHOT }).catch(async () => {
		await page.screenshot({ path: CAPTCHA_SHOT });
	});
	log(`КАПЧА: скриншот ${CAPTCHA_SHOT}, жду текст в ${CAPTCHA_FILE}`);
	const captchaText = await waitForCode(20 * 60 * 1000, CAPTCHA_FILE);
	if (captchaText === "") return false;
	const field = page.locator('input[type="text"]:visible').last();
	await field.fill(captchaText).catch(() => {});
	await sleep(800);
	const box = await button.boundingBox().catch(() => null);
	if (box !== null) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
	await sleep(6000);
	log(`после капчи: ${(await page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ").slice(0, 160)}`);
	return true;
}

async function waitForCode(timeoutMs, file = CODE_FILE) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(file)) {
			const raw = readFileSync(file, "utf8").trim();
			const code = file === CAPTCHA_FILE ? raw : raw.replace(/\D/g, "").trim();
			if (code.length >= 4) return code;
		}
		await sleep(3000);
	}
	return "";
}

if (PHONE.length < 10) {
	log("нужен телефон: 10–11 цифр без +7");
	process.exit(2);
}

const env = loadStoreEnv();
const { chromium } = await loadPlaywright();
const context = await chromium.launchPersistentContext(profileDir(env), {
	// важно: только видимый браузер — QRATOR (sso.kdvid.ru) блокирует headless
	headless: false,
	args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
	proxy: proxyFor(env),
	locale: "ru-RU",
	timezoneId: "Asia/Novosibirsk",
	viewport: { width: 1400, height: 1000 },
});
const page = context.pages()[0] ?? (await context.newPage());

try {
	await page.goto("https://yarcheplus.ru/signin", { timeout: 60_000, waitUntil: "domcontentloaded" });
	await page.waitForTimeout(4000);
	log(`страница входа: ${page.url()} — ${await page.title()}`);

	const phoneField = page.locator('input[name="phone"], input[type="tel"]').first();
	await phoneField.click({ timeout: 10_000 });
	await phoneField.fill("");
	await phoneField.pressSequentially(PHONE, { delay: 90 });
	await page.waitForTimeout(1500);
	log("телефон введён");

	// отправляем форму (кнопка «Войти» / submit)
	const submit = page.locator('form button[type="submit"], button:has-text("Войти")').first();
	await submit.click({ timeout: 10_000 }).catch((error) => log(`клик по «Войти»: ${error.message.slice(0, 80)}`));
	await page.waitForTimeout(8000);
	log(`после отправки телефона: ${page.url()}`);
	await page.screenshot({ path: "/tmp/yarche-login-after-phone.png" });

	// страница KDV ID: галочка согласия (кастомный чекбокс — работает только настоящий клик
	// мышью по координатам) + кнопка «Войти / Создать KDV ID» → появляется капча.
	const bodyText = async () => (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ");
	let advanced = false;
	for (let attempt = 1; attempt <= 5 && !advanced; attempt += 1) {
		const control = page.locator('[role="checkbox"], .ui-checkbox__control, label:has-text("Я принимаю")').first();
		const box = await control.boundingBox().catch(() => null);
		if (box !== null && box.width > 0) {
			await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
			await page.waitForTimeout(1200);
		}
		const button = page.locator('button:has-text("Войти / Создать KDV ID"), button:has-text("Войти")').first();
		await button.click({ timeout: 10_000 }).catch((error) => log(`клик по кнопке входа: ${error.message.slice(0, 60)}`));
		await page.waitForTimeout(8000);
		const after = await bodyText();
		advanced = !/Необходимо принять условия/.test(after);
		log(`попытка ${attempt}: ${after.slice(0, 120)}`);
	}
	await page.screenshot({ path: "/tmp/yarche-login-code.png" });

	// капча Яндекса (SmartCaptcha) — только если поле кода ещё не появилось
	const pageText = async () => (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ");
	const codeFieldVisible = async () =>
		/Код подтверждения|Мы отправили код/i.test(await pageText()) ||
		(await page.locator('input[placeholder*="Код подтверждения"], input[name*="code" i], input[maxlength="1"]').count()) > 0;
	const captchaInput = page.locator('input[type="text"]:visible, input[placeholder*="картинки"]:visible').last();
	const captchaButton = page.locator('button:has-text("Отправить")').first();
	if (!(await codeFieldVisible()) && (await captchaButton.count()) > 0) {
		await page.locator('[class*="captcha" i], iframe[src*="captcha"]').first().screenshot({ path: CAPTCHA_SHOT }).catch(async () => {
			await page.screenshot({ path: CAPTCHA_SHOT });
		});
		log(`КАПЧА: скриншот ${CAPTCHA_SHOT}, жду текст в ${CAPTCHA_FILE} (до 20 минут)`);
		const captchaText = await waitForCode(20 * 60 * 1000, CAPTCHA_FILE);
		if (captchaText === "") {
			log("текст капчи не появился — выход");
			await context.close();
			process.exit(3);
		}
		log(`ввожу текст капчи (${captchaText.length} символов)`);
		await captchaInput.click({ timeout: 8000 }).catch(() => {});
		await captchaInput.pressSequentially(captchaText, { delay: 120 });
		await captchaButton.click({ timeout: 10_000 }).catch((error) => log(`клик «Отправить»: ${error.message.slice(0, 60)}`));
		await page.waitForTimeout(9000);
		await page.screenshot({ path: "/tmp/yarche-login-after-captcha.png" });
		log(`после капчи: ${(await page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ").slice(0, 200)}`);
	}

	// ждём код
	log(`жду SMS-код в ${CODE_FILE} (до 20 минут)`);
	const code = await waitForCode(20 * 60 * 1000);
	if (code === "") {
		log("код не появился — выход");
		await context.close();
		process.exit(3);
	}
	log(`получен код из ${code.length} цифр, ввожу`);

	// ищем поля кода: либо один input, либо несколько однозначных
	const fields = await page.evaluate(() => [...document.querySelectorAll("input")].map((i, index) => ({ index, name: i.name, ph: i.placeholder, maxLength: i.maxLength, type: i.type, visible: i.offsetParent !== null })));
	log(`поля после запроса кода: ${JSON.stringify(fields)}`);
	const single = page.locator("input[maxlength='1']");
	if (await single.count() >= 4) {
		for (let i = 0; i < code.length && i < (await single.count()); i += 1) {
			await single.nth(i).fill(code[i]);
			await page.waitForTimeout(200);
		}
	} else {
		// заполняем без клика: по полю кода может «лежать» оверлей модалки
		const codeField = page.locator('input[placeholder*="Код"], input[name*="code" i], input[inputmode="numeric"]').first();
		await codeField.fill(code, { timeout: 15_000 }).catch(async (error) => {
			log(`fill не сработал (${error.message.slice(0, 60)}), пробую force-клик`);
			await codeField.click({ timeout: 8000, force: true }).catch(() => {});
			await page.keyboard.type(code, { delay: 120 });
		});
	}
	await page.waitForTimeout(2000);

	// галочка «Я принимаю условия»: без неё «Отправить» остаётся серой
	const submitBtnProbe = page.locator('button:has-text("Отправить")').first();
	if (await submitBtnProbe.isDisabled().catch(() => false)) {
		const agree = page.locator('label:has-text("Я принимаю"), [role="checkbox"], input[type="checkbox"]').first();
		const agreeBox = await agree.boundingBox().catch(() => null);
		if (agreeBox !== null) {
			await page.mouse.click(agreeBox.x + 8, agreeBox.y + Math.min(10, agreeBox.height / 2)).catch(() => {});
			await page.waitForTimeout(900);
			log(`галочка согласия: ${(await submitBtnProbe.isDisabled().catch(() => true)) ? "всё ещё серая" : "отмечена, кнопка активна"}`);
		} else {
			log("чекбокс согласия не найден");
		}
	}

	// кнопку «Отправить» может перекрывать оверлей — жмём настоящим кликом по координатам
	const codeSubmit = page.locator('button:has-text("Отправить"), form button[type="submit"], button:has-text("Войти")').first();
	let submitted = false;
	for (let attempt = 1; attempt <= 4 && !submitted; attempt += 1) {
		const box = await codeSubmit.boundingBox().catch(() => null);
		if (attempt === 1) {
			await page.keyboard.press("Enter").catch(() => {});
		} else if (box !== null && box.width > 0) {
			const onTop = await page.evaluate(([x, y]) => {
				const el = document.elementFromPoint(x, y);
				return el ? `${el.tagName}.${(el.className || "").toString().slice(0, 40)}` : "нет";
			}, [box.x + box.width / 2, box.y + box.height / 2]);
			log(`над кнопкой «Отправить»: ${onTop}`);
			await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
		} else {
			await page.locator('button:has-text("Отправить")').first().click({ timeout: 5000, force: true }).catch(() => {});
		}
		await page.waitForTimeout(6000);
		await solveCaptchaIfPresent(page, log);
		const text = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ");
		if (!/Мы отправили код подтверждения/.test(text)) submitted = true;
		log(`отправка кода, попытка ${attempt}: ${text.slice(0, 220)}`);
	}
	await page.waitForTimeout(4000);

	const state = await page.evaluate(() => ({
		url: location.href,
		text: document.body.innerText.replace(/\s+/g, " ").slice(0, 400),
		loggedIn: !document.querySelector('a[href*="signin"]'),
	}));
	log(`после ввода кода: url=${state.url} | признак входа=${state.loggedIn} | ${state.text.slice(0, 200)}`);
	await page.screenshot({ path: "/tmp/yarche-login-done.png" });
	if (existsSync(CODE_FILE)) unlinkSync(CODE_FILE);
	await context.close();
	process.exit(state.loggedIn ? 0 : 4);
} catch (error) {
	log(`ошибка: ${error?.message ?? error}`);
	await context.close().catch(() => {});
	process.exit(1);
}
