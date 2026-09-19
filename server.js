const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AppDatabase, validateTelegramConfig } = require('./lib/database');
const { runRedemption, fetchCoupons } = require('./lib/redeemer');
const { checkForNewCoupons } = require('./lib/coupon-checker');
const {
    sendTelegramMessage, setTelegramWebhook, deleteTelegramWebhook,
    parseTelegramCommand, buildRecordsMessage, buildJobMessage
} = require('./lib/telegram');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Math.max(1, Number(process.env.PORT || 3000));
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const SESSION_HOURS = Math.max(1, Number(process.env.SESSION_HOURS || 168));
const defaultRedeemDelay = parseRange(process.env.REDEEM_DELAY_MS || '4500-12000');
const defaultActionDelay = parseRange(process.env.ACTION_DELAY_MS || '800-2200');
const AUTOMATION_DEFAULTS = {
    enabled: envBoolean(process.env.COUPON_CHECK_ENABLED, envBoolean(process.env.AUTO_REDEEM, true)),
    scheduleTime: `${String(clamp(process.env.AUTO_REDEEM_HOUR, 0, 23, 12)).padStart(2, '0')}:${String(clamp(process.env.AUTO_REDEEM_MINUTE, 0, 59, 0)).padStart(2, '0')}`,
    timezone: process.env.APP_TIMEZONE || 'Asia/Shanghai',
    redeemDelayMinMs: defaultRedeemDelay.min,
    redeemDelayMaxMs: defaultRedeemDelay.max,
    actionDelayMinMs: defaultActionDelay.min,
    actionDelayMaxMs: defaultActionDelay.max,
    intervalHours: halfHourRange(process.env.COUPON_CHECK_HOURS, 0.5, 168, 1)
};

const db = new AppDatabase(path.join(DATA_DIR, 'swcoupon.sqlite'));
const createdAdmin = db.initializeAdmin(process.env.ADMIN_USERNAME || 'admin', process.env.ADMIN_PASSWORD);
if (createdAdmin) console.log(`Administrator "${process.env.ADMIN_USERNAME || 'admin'}" created.`);
else if (db.needsSetup()) console.log('No administrator exists. Open the web console to create the initial account.');

const jobState = { running: false, jobId: null, progress: null, error: null, startedAt: null, triggerType: null, couponCodes: null };
const couponCheckState = { running: false, nextCheckAt: null };
const loginAttempts = new Map();
let activeIntervalHours = null;

function startJob(accountId, triggerType, preloadedCoupons = null, fromCouponCheck = false) {
    if (jobState.running || (couponCheckState.running && !fromCouponCheck)) return false;
    jobState.running = true;
    jobState.jobId = null;
    jobState.progress = { fetched: 0, success: 0, skipped: 0, failed: 0 };
    jobState.error = null;
    jobState.startedAt = new Date().toISOString();
    jobState.triggerType = triggerType;
    jobState.couponCodes = preloadedCoupons;
    const automation = db.getAutomationConfig(AUTOMATION_DEFAULTS);
    setImmediate(async () => {
        let jobError = null;
        try {
            await runRedemption({
                db, accountId, triggerType,
                options: {
                    pageTimeoutMs: Math.max(5000, Number(process.env.PAGE_TIMEOUT_MS || 30000)),
                    redeemDelayMs: { min: automation.redeemDelayMinMs, max: automation.redeemDelayMaxMs },
                    actionDelayMs: { min: automation.actionDelayMinMs, max: automation.actionDelayMaxMs },
                    ...(preloadedCoupons ? { fetchCoupons: async () => preloadedCoupons } : {})
                },
                hooks: {
                    onStart: ({ jobId, summary }) => Object.assign(jobState, { jobId, progress: { ...summary } }),
                    onProgress: ({ summary }) => { jobState.progress = summary; },
                    onFinish: ({ summary, error }) => Object.assign(jobState, { progress: { ...summary }, error: error || null })
                }
            });
        } catch (error) {
            jobError = error.message;
            jobState.error = error.message;
            console.error('Redemption job failed:', error.stack || error.message);
        } finally {
            await sendJobNotification(triggerType, jobError, automation.timezone);
            jobState.running = false;
        }
    });
    return true;
}

function startCouponCheck(triggerType) {
    if (couponCheckState.running || jobState.running) return false;
    couponCheckState.running = true;
    setImmediate(async () => {
        try {
            const result = await checkForNewCoupons({ db, fetchCoupons, triggerType });
            if (result.pendingCodes.length) startJob(null, 'interval', result.pendingCodes, true);
        } catch (error) {
            console.warn(`Coupon check failed: ${error.message}`);
        } finally {
            couponCheckState.running = false;
        }
    });
    return true;
}

async function sendJobNotification(triggerType, error, timezone) {
    const telegram = db.getTelegramConfig();
    if (!telegram.enabled) return;
    try {
        await sendTelegramMessage(telegram, buildJobMessage({
            summary: jobState.progress || {}, triggerType, error,
            startedAt: jobState.startedAt, timezone, couponCodes: jobState.couponCodes || []
        }));
    } catch (notificationError) {
        console.warn(`Telegram notification failed: ${notificationError.message}`);
    }
}

async function processTelegramUpdate(update, telegram) {
    const command = parseTelegramCommand(update, telegram.chatId);
    if (!command) return;
    try {
        await handleTelegramCommand(command, telegram);
    } catch (error) {
        console.warn(`Telegram command failed: ${error.message}`);
    }
}

async function handleTelegramCommand(command, telegram) {
    if (command.name === 'redeem') {
        if (!db.listAccounts(true).length) {
            return sendTelegramMessage(telegram, '⚠️ 没有已启用的兑换账号，请先在后台添加并启用账号。');
        }
        if (!startJob(null, 'telegram')) {
            return sendTelegramMessage(telegram, '⚠️ 当前已有兑换或检查任务正在运行，请稍后再试。');
        }
        return sendTelegramMessage(telegram, '▶️ 已通过 Telegram 命令启动全部账号的立即兑换。');
    }
    if (command.name === 'records') {
        const numericLimit = /^\d+$/.test(command.argument) ? Number(command.argument) : null;
        const pageSize = numericLimit == null ? 10 : Math.min(20, Math.max(1, numericLimit));
        const query = numericLimit == null ? command.argument : '';
        const records = db.listRecords({ pageSize, query }).items;
        const timezone = db.getAutomationConfig(AUTOMATION_DEFAULTS).timezone;
        return sendTelegramMessage(telegram, buildRecordsMessage(records, timezone));
    }
}

const server = http.createServer(async (req, res) => {
    try {
        setSecurityHeaders(res);
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
        return serveStatic(req, res, url.pathname);
    } catch (error) {
        console.error(error.stack || error.message);
        const isConflict = String(error.code || '').includes('SQLITE_CONSTRAINT_UNIQUE');
        const status = error.statusCode || (isConflict ? 409 : /必填|无效|至少|不能超过|格式|用户名|密码|不一致|请填写|Telegram|时间|时区|延迟/.test(error.message) ? 400 : 500);
        json(res, status, { error: status === 500 ? '服务器内部错误' : isConflict ? '相同 Hive ID 和服务器的账号已存在' : error.message });
    }
});

async function handleApi(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true });
    if (req.method === 'POST' && url.pathname === '/api/telegram/webhook') {
        const telegram = db.getTelegramConfig();
        if (!telegram.enabled || !validWebhookSecret(req.headers['x-telegram-bot-api-secret-token'], telegram.webhookSecret)) {
            return json(res, 403, { error: 'Invalid Telegram webhook secret' });
        }
        const update = await readJson(req);
        setImmediate(() => processTelegramUpdate(update, telegram));
        return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/setup-status') {
        return json(res, 200, { required: db.needsSetup() });
    }
    if (req.method === 'POST' && url.pathname === '/api/setup') {
        requireSameOrigin(req);
        if (!db.needsSetup()) return json(res, 409, { error: '管理员已经创建，请直接登录' });
        const body = await readJson(req);
        if (body.password !== body.confirmPassword) return json(res, 400, { error: '两次输入的密码不一致' });
        const user = db.createInitialAdmin(body.username, body.password);
        const session = db.createSession(user.id, SESSION_HOURS);
        res.setHeader('Set-Cookie', sessionCookie(session.token, req));
        console.log(`Initial administrator "${user.username}" created from the setup page.`);
        return json(res, 201, { user });
    }
    if (req.method === 'POST' && url.pathname === '/api/login') {
        requireSameOrigin(req);
        const remoteAddress = req.socket.remoteAddress || 'unknown';
        const attempt = loginAttempts.get(remoteAddress);
        if (attempt && attempt.resetAt > Date.now() && attempt.count >= 5) {
            return json(res, 429, { error: '登录失败次数过多，请 15 分钟后再试' });
        }
        const body = await readJson(req);
        const user = db.authenticate(body.username, body.password);
        if (!user) {
            const current = attempt?.resetAt > Date.now() ? attempt : { count: 0, resetAt: Date.now() + 15 * 60_000 };
            current.count += 1;
            loginAttempts.set(remoteAddress, current);
            return json(res, 401, { error: '用户名或密码错误' });
        }
        loginAttempts.delete(remoteAddress);
        const session = db.createSession(user.id, SESSION_HOURS);
        res.setHeader('Set-Cookie', sessionCookie(session.token, req));
        return json(res, 200, { user });
    }

    const token = parseCookies(req.headers.cookie || '').swcoupon_session;
    const user = db.getSession(token);
    if (!user) return json(res, 401, { error: '请先登录' });
    if (!['GET', 'HEAD'].includes(req.method)) requireSameOrigin(req);

    if (req.method === 'POST' && url.pathname === '/api/logout') {
        db.deleteSession(token);
        res.setHeader('Set-Cookie', clearSessionCookie(req));
        return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/me') return json(res, 200, { user: { id: user.id, username: user.username } });
    if (req.method === 'POST' && url.pathname === '/api/password') {
        const body = await readJson(req);
        if (!db.changePassword(user.id, body.currentPassword, body.newPassword)) {
            return json(res, 400, { error: '当前密码不正确' });
        }
        res.setHeader('Set-Cookie', clearSessionCookie(req));
        return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/dashboard') {
        return json(res, 200, { ...db.dashboard(), job: publicJobState() });
    }
    if (req.method === 'GET' && url.pathname === '/api/automation') {
        return json(res, 200, publicAutomationConfig(db.getAutomationConfig(AUTOMATION_DEFAULTS)));
    }
    if (req.method === 'PUT' && url.pathname === '/api/automation') {
        const body = await readJson(req);
        const config = db.saveAutomationConfig({
            enabled: body.enabled,
            timezone: body.timezone,
            redeemDelayMinMs: secondsToMilliseconds(body.redeemDelayMinSeconds, '兑换随机延迟'),
            redeemDelayMaxMs: secondsToMilliseconds(body.redeemDelayMaxSeconds, '兑换随机延迟'),
            actionDelayMinMs: secondsToMilliseconds(body.actionDelayMinSeconds, '页面操作随机延迟'),
            actionDelayMaxMs: secondsToMilliseconds(body.actionDelayMaxSeconds, '页面操作随机延迟'),
            intervalHours: body.intervalHours
        }, AUTOMATION_DEFAULTS);
        syncIntervalSchedule(config, true);
        return json(res, 200, publicAutomationConfig(config));
    }
    if (req.method === 'GET' && url.pathname === '/api/coupon-check') {
        return json(res, 200, publicCouponCheckState());
    }
    if (req.method === 'POST' && url.pathname === '/api/coupon-check') {
        if (!db.listAccounts(true).length) return json(res, 400, { error: '请先添加并启用至少一个兑换账号' });
        if (!startCouponCheck('manual')) return json(res, 409, { error: '兑换或检查任务正在运行' });
        return json(res, 202, publicCouponCheckState());
    }
    if (req.method === 'GET' && url.pathname === '/api/telegram') {
        return json(res, 200, publicTelegramConfig(db.getTelegramConfig()));
    }
    if (req.method === 'PUT' && url.pathname === '/api/telegram') {
        const body = await readJson(req);
        const previous = db.getTelegramConfig();
        const webhookUrl = body.enabled === true ? publicOrigin(req) : previous.webhookUrl;
        if (body.enabled === true && !webhookUrl.startsWith('https://')) {
            return json(res, 400, { error: 'Telegram Webhook 需要通过公网 HTTPS 地址访问并保存配置' });
        }
        const config = db.saveTelegramConfig({ ...body, webhookUrl });
        try {
            if (config.enabled) await setTelegramWebhook(config, { dropPendingUpdates: true });
            else if (previous.botToken) await deleteTelegramWebhook(previous);
        } catch (error) {
            return json(res, 502, { error: error.message });
        }
        return json(res, 200, publicTelegramConfig(config));
    }
    if (req.method === 'POST' && url.pathname === '/api/telegram/test') {
        const body = await readJson(req);
        const saved = db.getTelegramConfig();
        const config = {
            botToken: String(body.botToken || '').trim() || saved.botToken,
            chatId: body.chatId === undefined ? saved.chatId : String(body.chatId || '').trim(),
            enabled: true
        };
        validateTelegramConfig(config, true);
        try {
            const timezone = db.getAutomationConfig(AUTOMATION_DEFAULTS).timezone;
            await sendTelegramMessage(config, `✅ SW Coupon Console 测试消息\n\nTelegram 推送配置正确。\n时间：${new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'medium', hour12: false }).format(new Date())}`);
        } catch (error) {
            return json(res, 502, { error: error.message });
        }
        return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/accounts') {
        return json(res, 200, { items: db.listAccounts(false, url.searchParams.get('query')) });
    }
    if (req.method === 'POST' && url.pathname === '/api/accounts') {
        const account = db.createAccount(await readJson(req));
        return json(res, 201, { account });
    }
    const accountMatch = url.pathname.match(/^\/api\/accounts\/(\d+)$/);
    if (accountMatch && req.method === 'PUT') {
        const account = db.updateAccount(Number(accountMatch[1]), await readJson(req));
        return account ? json(res, 200, { account }) : json(res, 404, { error: '账号不存在' });
    }
    if (accountMatch && req.method === 'DELETE') {
        return db.deleteAccount(Number(accountMatch[1])) ? json(res, 200, { ok: true }) : json(res, 404, { error: '账号不存在' });
    }
    if (req.method === 'GET' && url.pathname === '/api/records') {
        return json(res, 200, db.listRecords({
            page: url.searchParams.get('page'), pageSize: url.searchParams.get('pageSize'),
            accountId: url.searchParams.get('accountId'), status: url.searchParams.get('status'), query: url.searchParams.get('query')
        }));
    }
    if (req.method === 'GET' && url.pathname === '/api/job') return json(res, 200, publicJobState());
    if (req.method === 'POST' && url.pathname === '/api/redeem') {
        const body = await readJson(req);
        const accountId = body.accountId == null ? null : Number(body.accountId);
        if (accountId && !db.getAccount(accountId)) return json(res, 404, { error: '账号不存在' });
        if (!startJob(accountId, 'manual')) return json(res, 409, { error: '兑换或检查任务正在运行' });
        return json(res, 202, { ok: true, job: publicJobState() });
    }
    return json(res, 404, { error: '接口不存在' });
}

function publicJobState() {
    return {
        running: jobState.running, jobId: jobState.jobId, progress: jobState.progress,
        error: jobState.error, startedAt: jobState.startedAt, triggerType: jobState.triggerType
    };
}

function publicTelegramConfig(config) {
    return {
        enabled: config.enabled, chatId: config.chatId, hasBotToken: Boolean(config.botToken),
        webhookConfigured: Boolean(config.webhookUrl && config.webhookSecret)
    };
}

function publicAutomationConfig(config) {
    return {
        enabled: config.enabled,
        timezone: config.timezone,
        redeemDelayMinSeconds: config.redeemDelayMinMs / 1000,
        redeemDelayMaxSeconds: config.redeemDelayMaxMs / 1000,
        actionDelayMinSeconds: config.actionDelayMinMs / 1000,
        actionDelayMaxSeconds: config.actionDelayMaxMs / 1000,
        intervalHours: config.intervalHours
    };
}

function publicCouponCheckState() {
    return {
        running: couponCheckState.running,
        nextCheckAt: couponCheckState.nextCheckAt,
        latest: db.latestCouponCheck()
    };
}

function serveStatic(req, res, pathname) {
    if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Method not allowed' });
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const filename = path.resolve(PUBLIC_DIR, relative);
    if (!filename.startsWith(`${PUBLIC_DIR}${path.sep}`)) return json(res, 404, { error: 'Not found' });
    fs.readFile(filename, (error, content) => {
        if (error) {
            if (!path.extname(relative)) return serveStatic(req, res, '/');
            return json(res, 404, { error: 'Not found' });
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', contentType(filename));
        res.setHeader('Cache-Control', 'no-cache');
        res.end(req.method === 'HEAD' ? undefined : content);
    });
}

function requireSameOrigin(req) {
    if (req.headers['x-sw-coupon'] === 'web') return;
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (!origin || !host || new URL(origin).host !== host) {
        const error = new Error('Invalid request origin');
        error.statusCode = 403;
        throw error;
    }
}

async function readJson(req) {
    let body = '';
    for await (const chunk of req) {
        body += chunk;
        if (body.length > 1_000_000) {
            const error = new Error('请求内容过大');
            error.statusCode = 413;
            throw error;
        }
    }
    try { return body ? JSON.parse(body) : {}; } catch { throw new Error('JSON 格式无效'); }
}

function json(res, status, data) {
    if (res.headersSent) return;
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(data));
}

function setSecurityHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
}

function sessionCookie(token, req) {
    const secure = isSecure(req) ? '; Secure' : '';
    return `swcoupon_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}${secure}`;
}
function clearSessionCookie(req) { return `swcoupon_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isSecure(req) ? '; Secure' : ''}`; }
function isSecure(req) { return req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'; }
function publicOrigin(req) {
    return `${isSecure(req) ? 'https' : 'http'}://${req.headers.host || 'localhost'}`;
}
function validWebhookSecret(received, expected) {
    const actual = Buffer.from(String(received || ''));
    const wanted = Buffer.from(String(expected || ''));
    return actual.length > 0 && actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted);
}
function parseCookies(value) {
    return Object.fromEntries(value.split(';').map((part) => part.trim().split('=').map(decodeURIComponent)).filter((pair) => pair.length === 2));
}
function contentType(filename) {
    return ({ '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' })[path.extname(filename)] || 'application/octet-stream';
}
function parseRange(value) {
    const match = String(value).match(/^(\d+)\s*[-,:~]\s*(\d+)$/);
    if (!match) { const n = Math.max(0, Number(value) || 0); return { min: n, max: n }; }
    return { min: Math.min(Number(match[1]), Number(match[2])), max: Math.max(Number(match[1]), Number(match[2])) };
}

function secondsToMilliseconds(value, label) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`${label}格式无效`);
    return number * 1000;
}

function clamp(value, min, max, fallback) {
    const number = Number(value);
    return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

function halfHourRange(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number >= min && number <= max && number * 2 % 1 === 0 ? number : fallback;
}

function envBoolean(value, fallback) {
    if (value === undefined) return fallback;
    return !/^(0|false|no|off)$/i.test(value);
}

function syncIntervalSchedule(automation, reset = false) {
    if (!automation.enabled) {
        couponCheckState.nextCheckAt = null;
        activeIntervalHours = null;
        return;
    }
    if (reset || activeIntervalHours !== automation.intervalHours || !couponCheckState.nextCheckAt) {
        activeIntervalHours = automation.intervalHours;
        couponCheckState.nextCheckAt = new Date(Date.now() + automation.intervalHours * 3_600_000).toISOString();
    }
}

function checkIntervalSchedule() {
    const automation = db.getAutomationConfig(AUTOMATION_DEFAULTS);
    syncIntervalSchedule(automation);
    if (!couponCheckState.nextCheckAt || Date.now() < new Date(couponCheckState.nextCheckAt).getTime()) return;
    if (startCouponCheck('interval')) {
        couponCheckState.nextCheckAt = new Date(Date.now() + automation.intervalHours * 3_600_000).toISOString();
    }
}

const intervalCheckTimer = setInterval(checkIntervalSchedule, 30_000);
intervalCheckTimer.unref();
syncIntervalSchedule(db.getAutomationConfig(AUTOMATION_DEFAULTS));
const savedTelegram = db.getTelegramConfig();
if (savedTelegram.enabled && savedTelegram.webhookUrl && savedTelegram.webhookSecret) {
    setImmediate(() => setTelegramWebhook(savedTelegram).catch((error) => {
        console.warn(`Telegram webhook restore failed: ${error.message}`);
    }));
}

server.listen(PORT, HOST, () => {
    const automation = db.getAutomationConfig(AUTOMATION_DEFAULTS);
    console.log(`SW Coupon Console listening on http://${HOST}:${PORT}`);
    console.log(automation.enabled
        ? `Coupon check: every ${automation.intervalHours} hour(s) (${automation.timezone})`
        : 'Scheduled coupon checking is disabled.');
});

function shutdown(signal) {
    console.log(`${signal} received, shutting down.`);
    clearInterval(intervalCheckTimer);
    server.close(() => {
        db.close();
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
