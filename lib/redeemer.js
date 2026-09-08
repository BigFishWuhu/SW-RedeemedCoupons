const COUPON_LIST_URL = 'https://swgt.io/controllers/dashboard/loadSummonersWarGameCodes';
const HIVE_COUPON_PAGE_URL = 'https://event.withhive.com/ci/smon/evt_coupon';

async function fetchCoupons() {
    const response = await fetch(COUPON_LIST_URL, {
        headers: { Accept: 'text/html,application/json', 'User-Agent': 'swcoupon-web' },
        signal: AbortSignal.timeout(30_000)
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`获取兑换码失败（HTTP ${response.status}）：${shortText(text)}`);
    const pattern = /\bdata-clipboard-text\s*=\s*(["'])([^"']+)\1/gi;
    const codes = new Set();
    let match;
    while ((match = pattern.exec(text)) !== null) {
        const code = match[2].trim().toUpperCase();
        if (code) codes.add(code);
    }
    return Array.from(codes);
}

async function createBrowserRedeemer(options = {}) {
    const { chromium } = require('playwright');
    const browser = await chromium.launch({ headless: options.headless !== false });
    try {
        const context = await browser.newContext({
            locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1365, height: 768 }
        });
        const page = await context.newPage();
        page.setDefaultTimeout(options.pageTimeoutMs || 30_000);
        await page.goto(HIVE_COUPON_PAGE_URL, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
        return {
            redeem: (code, account) => redeemWithPage(page, code, account, options),
            close: () => browser.close()
        };
    } catch (error) {
        await browser.close().catch(() => {});
        throw error;
    }
}

async function redeemWithPage(page, couponCode, account, options) {
    const actionDelay = options.actionDelayMs || { min: 800, max: 2200 };
    return page.evaluate(async ({ couponCode, account, actionDelay }) => {
        const payload = { country: 'NL', lang: 'en', server: account.server, hiveid: account.hiveId, coupon: couponCode };
        async function request(endpoint) {
            const url = `evt_coupon/${endpoint}`;
            if (window.jQuery && typeof window.jQuery.ajax === 'function') {
                return new Promise((resolve) => window.jQuery.ajax({
                    url, dataType: 'JSON', type: 'post', data: payload,
                    success: resolve,
                    error: (xhr, status, error) => resolve({
                        retCode: xhr?.status || status || 'ajax-error',
                        retMsg: xhr?.responseText || String(error || status || 'AJAX request failed')
                    })
                }));
            }
            const response = await fetch(url, {
                method: 'POST', body: new URLSearchParams(payload), credentials: 'same-origin',
                headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' }
            });
            const text = await response.text();
            try { return JSON.parse(text); } catch { return { retCode: response.status, retMsg: text.slice(0, 500) }; }
        }
        const checkResult = await request('checkUser');
        if (Number(checkResult?.retCode) !== 100) return { checkResult, redeemResult: null };
        const delay = Math.floor(Math.random() * (actionDelay.max - actionDelay.min + 1)) + actionDelay.min;
        await new Promise((resolve) => window.setTimeout(resolve, delay));
        return { checkResult, redeemResult: await request('useCoupon') };
    }, { couponCode, account: { hiveId: account.hiveId, server: account.server }, actionDelay });
}

function classifyResponse(checkResult, redeemResult) {
    if (!isSuccess(checkResult)) {
        return alreadyRedeemed(checkResult)
            ? successResult('already-redeemed', 'checkUser', checkResult)
            : failureResult('checkUser', checkResult);
    }
    if (isSuccess(redeemResult)) return successResult('redeemed', 'useCoupon', redeemResult);
    if (alreadyRedeemed(redeemResult)) return successResult('already-redeemed', 'useCoupon', redeemResult);
    return failureResult('useCoupon', redeemResult);
}

function successResult(status, stage, response) {
    return { status, stage, retCode: response?.retCode ?? null, message: messageOf(response) };
}

function failureResult(stage, response) {
    return { status: 'failed', stage, retCode: response?.retCode ?? null, message: messageOf(response) };
}

function isSuccess(response) { return response && Number(response.retCode) === 100; }
function alreadyRedeemed(response) {
    if (String(response?.retCode || '').toUpperCase().includes('H304')) return true;
    return /already|redeemed|used|duplicate|已|使用|兑换/i.test(messageOf(response));
}
function messageOf(response) { return response?.retMsg ? String(response.retMsg).slice(0, 1000) : JSON.stringify(response || {}); }
function shortText(value) { return String(value || '').replace(/\s+/g, ' ').slice(0, 500); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function runRedemption({ db, accountId = null, triggerType = 'manual', options = {}, hooks = {} }) {
    const accounts = accountId ? [db.getAccount(accountId)].filter(Boolean) : db.listAccounts(true);
    if (accountId && !accounts.length) throw new Error('兑换账号不存在');
    const activeAccounts = accounts.filter((account) => account.enabled);
    if (!activeAccounts.length) throw new Error('没有可用的兑换账号');

    const jobId = db.createJob(triggerType, accountId);
    const summary = { fetched: 0, success: 0, skipped: 0, failed: 0 };
    let browserRedeemer;
    hooks.onStart?.({ jobId, summary });
    try {
        const coupons = await (options.fetchCoupons || fetchCoupons)();
        summary.fetched = coupons.length;
        const tasks = [];
        for (const account of activeAccounts) {
            for (const code of coupons) {
                if (db.hasSuccessfulRecord(account.id, code)) summary.skipped += 1;
                else tasks.push({ account, code });
            }
        }
        if (tasks.length) browserRedeemer = await (options.createRedeemer || createBrowserRedeemer)(options);
        for (const [index, task] of tasks.entries()) {
            let result;
            try {
                const response = await browserRedeemer.redeem(task.code, task.account);
                result = classifyResponse(response.checkResult, response.redeemResult);
            } catch (error) {
                result = { status: 'failed', stage: 'request', retCode: null, message: error.message };
            }
            db.addRecord(jobId, task.account, task.code, result);
            if (result.status === 'failed') summary.failed += 1;
            else summary.success += 1;
            hooks.onProgress?.({ jobId, summary: { ...summary }, account: task.account, couponCode: task.code, result });
            if (index < tasks.length - 1) await sleep(randomDelay(options.redeemDelayMs || { min: 4500, max: 12000 }));
        }
        db.finishJob(jobId, summary);
        hooks.onFinish?.({ jobId, summary });
        return { jobId, ...summary };
    } catch (error) {
        db.finishJob(jobId, summary, error.message);
        hooks.onFinish?.({ jobId, summary, error: error.message });
        throw error;
    } finally {
        if (browserRedeemer) await browserRedeemer.close().catch(() => {});
    }
}

function randomDelay(range) {
    const min = Math.max(0, Number(range.min) || 0);
    const max = Math.max(min, Number(range.max) || min);
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

module.exports = { fetchCoupons, createBrowserRedeemer, classifyResponse, runRedemption };
