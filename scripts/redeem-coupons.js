const crypto = require('node:crypto');
const { chromium } = require('playwright');

const COUPON_LIST_URL = 'https://sw-coupons.netlify.app/.netlify/functions/get-coupons';
const HIVE_COUPON_PAGE_URL = 'https://event.withhive.com/ci/smon/evt_coupon';
const VALID_STATUSES = new Set(['valid', 'verified']);
const SERVER_LABELS = new Set(['global', 'korea', 'japan', 'china', 'asia', 'europe']);
const CLOUDFLARE_API_BASE_URL = 'https://api.cloudflare.com/client/v4';

const config = {
    accounts: parseAccounts(),
    country: String(process.env.SW_COUNTRY || 'NL').trim(),
    lang: String(process.env.SW_LANG || 'en').trim(),
    includeExpired: parseBoolean(process.env.INCLUDE_EXPIRED),
    startDelayRangeMs: parseDelayRange(process.env.START_DELAY_MS || '0-180000'),
    delayRangeMs: parseDelayRange(process.env.REDEEM_DELAY_MS || '4500-12000'),
    actionDelayRangeMs: parseDelayRange(process.env.ACTION_DELAY_MS || '800-2200'),
    pageTimeoutMs: Math.max(5000, Number(process.env.PAGE_TIMEOUT_MS || 30000)),
    kvAccountId: String(process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID || '').trim(),
    kvNamespaceId: String(process.env.CLOUDFLARE_KV_NAMESPACE_ID || process.env.CF_KV_NAMESPACE_ID || '').trim(),
    kvApiToken: String(process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || '').trim(),
    kvKeyPrefix: String(process.env.KV_KEY_PREFIX || 'swcoupon:redeemed').trim(),
    discordWebhookUrl: String(process.env.DISCORD_WEBHOOK_URL || '').trim(),
    dryRun: parseBoolean(process.env.DRY_RUN),
    headless: !parseBoolean(process.env.PLAYWRIGHT_HEADED)
};

async function main() {
    const summary = createSummary();
    let redeemer = null;

    try {
        validateConfig();

        summary.startDelayMs = randomInt(config.startDelayRangeMs.min, config.startDelayRangeMs.max);
        if (summary.startDelayMs > 0) {
            console.log(`Startup delay ${summary.startDelayMs}ms before querying coupons.`);
            await sleep(summary.startDelayMs);
        }

        const recordStore = createKvRecordStore();
        const coupons = await fetchCoupons();
        const tasks = [];

        summary.fetched = coupons.length;

        for (const accountConfig of config.accounts) {
            const recordAccount = await recordStore.loadAccount(accountConfig);
            const accountSummary = createAccountSummary(accountConfig);
            const queue = coupons.filter((coupon) => !recordAccount.redeemed[coupon.code]);

            accountSummary.skippedRecorded = coupons.length - queue.length;
            summary.accounts.push(accountSummary);

            for (const coupon of queue) {
                tasks.push({
                    accountConfig,
                    accountSummary,
                    recordAccount,
                    recordDirty: false,
                    coupon
                });
            }

            console.log(`Account ${maskHiveId(accountConfig.hiveId)} (${accountConfig.server}): fetched ${coupons.length}, ${queue.length} not recorded.`);
        }

        if (tasks.length && !config.dryRun) {
            redeemer = await createPageRedeemer();
        }

        for (const [index, task] of tasks.entries()) {
            if (config.dryRun) {
                task.accountSummary.dryRun.push(task.coupon.code);
                continue;
            }

            try {
                task.recordDirty = await redeemOne(task.coupon, task.recordAccount, task.accountSummary, redeemer, task.accountConfig);
            } catch (error) {
                task.accountSummary.failed.push({
                    code: task.coupon.code,
                    stage: 'request',
                    retCode: null,
                    message: error.message
                });
            }

            if (index < tasks.length - 1) {
                const delayMs = randomInt(config.delayRangeMs.min, config.delayRangeMs.max);
                console.log(`Waiting ${delayMs}ms before next coupon.`);
                await sleep(delayMs);
            }
        }

        const dirtyRecords = new Map();
        for (const task of tasks) {
            if (task.recordDirty) {
                dirtyRecords.set(task.recordAccount.hiveIdHash, {
                    accountConfig: task.accountConfig,
                    recordAccount: task.recordAccount
                });
            }
        }

        for (const { accountConfig, recordAccount } of dirtyRecords.values()) {
            await recordStore.saveAccount(accountConfig, recordAccount);
        }

        if (dirtyRecords.size) {
            summary.recordUpdated = true;
        }

        logSummary(summary);
        await sendDiscordNotification(summary);
    } catch (error) {
        summary.fatalError = error.message;
        await sendDiscordNotification(summary);
        throw error;
    } finally {
        if (redeemer) {
            await redeemer.close();
        }
    }
}

function validateConfig() {
    if (!config.accounts.length) {
        throw new Error('Missing HIVE_ACCOUNTS, HIVE_IDS, or HIVE_ID secret.');
    }

    for (const account of config.accounts) {
        if (!account.hiveId) {
            throw new Error('Every account must include a Hive ID.');
        }

        if (!SERVER_LABELS.has(account.server)) {
            throw new Error(`Invalid server "${account.server}" for Hive ID ${maskHiveId(account.hiveId)}. Use one of: ${Array.from(SERVER_LABELS).join(', ')}.`);
        }
    }

    if (!config.kvAccountId || !config.kvNamespaceId || !config.kvApiToken) {
        throw new Error('Missing Cloudflare KV credentials. Set CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_KV_NAMESPACE_ID, and CLOUDFLARE_API_TOKEN secrets.');
    }
}

async function fetchCoupons() {
    const response = await fetch(COUPON_LIST_URL, {
        headers: {
            Accept: 'application/json',
            'User-Agent': 'swcoupon-github-action'
        }
    });

    const text = await response.text();
    if (!response.ok) {
        throw new Error(`Coupon list request failed with HTTP ${response.status}: ${shortText(text)}`);
    }

    let data;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error(`Coupon list returned invalid JSON: ${shortText(text)}`);
    }

    const coupons = Array.isArray(data?.coupons) ? data.coupons : [];
    const byCode = new Map();

    for (const item of coupons) {
        const code = String(item?.code || '').trim().toUpperCase();
        if (!code) {
            continue;
        }

        if (!config.includeExpired && !VALID_STATUSES.has(String(item.status || '').toLowerCase())) {
            continue;
        }

        if (!byCode.has(code)) {
            byCode.set(code, {
                code,
                status: item.status || null,
                expiresAt: item.expiresAt || item.expireAt || item.expiredAt || null
            });
        }
    }

    return Array.from(byCode.values());
}

async function createPageRedeemer() {
    const browser = await chromium.launch({
        headless: config.headless
    });

    try {
        const context = await browser.newContext({
            locale: 'en-US',
            timezoneId: 'Europe/Amsterdam',
            viewport: { width: 1365, height: 768 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        });
        const page = await context.newPage();
        page.setDefaultTimeout(config.pageTimeoutMs);
        page.on('console', (message) => console.log(`[page:${message.type()}] ${message.text()}`));
        page.on('pageerror', (error) => console.warn(`[page:error] ${error.message}`));

        console.log(`Opening coupon page: ${HIVE_COUPON_PAGE_URL}`);
        await page.goto(HIVE_COUPON_PAGE_URL, {
            waitUntil: 'domcontentloaded',
            timeout: config.pageTimeoutMs
        });
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

        return {
            redeem: (coupon, accountConfig) => redeemWithPage(page, coupon, accountConfig),
            close: () => browser.close()
        };
    } catch (error) {
        await browser.close().catch(() => {});
        throw error;
    }
}

async function syncCouponPage(page, accountConfig) {
    await page.evaluate(({ hiveId, server }) => {
        function setValue(element, value) {
            if (!element) {
                return;
            }

            const prototype = element.tagName === 'SELECT'
                ? HTMLSelectElement.prototype
                : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;

            if (setter) {
                setter.call(element, value);
            } else {
                element.value = value;
            }

            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
        }

        const serverSelect = document.querySelector('#EVTselect');
        const hiveInput = document.querySelector('#EVTid');

        setValue(serverSelect, server);
        setValue(hiveInput, hiveId);

        if (serverSelect && window.jQuery && typeof window.jQuery.fn?.selectmenu === 'function') {
            try {
                window.jQuery(serverSelect).selectmenu('refresh');
            } catch {
                // The page sometimes loads without jQuery UI; the native select value is enough.
            }
        }
    }, {
        hiveId: accountConfig.hiveId,
        server: accountConfig.server
    });
}

async function redeemOne(coupon, account, accountSummary, redeemer, accountConfig) {
    console.log(`Checking ${coupon.code} for ${maskHiveId(accountConfig.hiveId)} (${accountConfig.server})`);
    const { checkResult, redeemResult } = await redeemer.redeem(coupon, accountConfig);
    if (!isSuccess(checkResult)) {
        if (looksAlreadyRedeemed(checkResult)) {
            account.redeemed[coupon.code] = createRecord(coupon, 'already-redeemed', checkResult, accountConfig);
            accountSummary.alreadyRedeemed.push(coupon.code);
            return true;
        }

        accountSummary.failed.push(toFailure(coupon.code, 'checkUser', checkResult));
        return false;
    }

    console.log(`Redeeming ${coupon.code} for ${maskHiveId(accountConfig.hiveId)} (${accountConfig.server})`);
    if (isSuccess(redeemResult)) {
        account.redeemed[coupon.code] = createRecord(coupon, 'redeemed', redeemResult, accountConfig);
        accountSummary.redeemed.push(coupon.code);
        return true;
    }

    if (looksAlreadyRedeemed(redeemResult)) {
        account.redeemed[coupon.code] = createRecord(coupon, 'already-redeemed', redeemResult, accountConfig);
        accountSummary.alreadyRedeemed.push(coupon.code);
        return true;
    }

    accountSummary.failed.push(toFailure(coupon.code, 'useCoupon', redeemResult));
    return false;
}

async function redeemWithPage(page, coupon, accountConfig) {
    await syncCouponPage(page, accountConfig);
    await sleep(randomInt(config.actionDelayRangeMs.min, config.actionDelayRangeMs.max));

    return page.evaluate(async ({ couponCode, config }) => {
        const payload = {
            country: config.country,
            lang: config.lang,
            server: config.server,
            hiveid: config.hiveId,
            coupon: couponCode
        };

        async function requestForm(endpoint) {
            const relativeUrl = `evt_coupon/${endpoint}`;

            if (window.jQuery && typeof window.jQuery.ajax === 'function') {
                return new Promise((resolve) => {
                    window.jQuery.ajax({
                        url: relativeUrl,
                        dataType: 'JSON',
                        type: 'post',
                        data: payload,
                        success: (response) => resolve(response),
                        error: (xhr, status, error) => {
                            resolve({
                                retCode: xhr?.status || status || 'ajax-error',
                                retMsg: xhr?.responseText || String(error || status || 'AJAX request failed')
                            });
                        }
                    });
                });
            }

            const response = await fetch(relativeUrl, {
                method: 'POST',
                body: new URLSearchParams(payload),
                credentials: 'same-origin',
                headers: {
                    Accept: 'application/json, text/javascript, */*; q=0.01',
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'X-Requested-With': 'XMLHttpRequest'
                }
            });
            const text = await response.text();

            if (!response.ok) {
                return {
                    retCode: response.status,
                    retMsg: `HTTP ${response.status}: ${text.replace(/\s+/g, ' ').slice(0, 500)}`
                };
            }

            try {
                return JSON.parse(text);
            } catch {
                return {
                    retCode: response.status,
                    retMsg: `Invalid JSON: ${text.replace(/\s+/g, ' ').slice(0, 500)}`
                };
            }
        }

        const checkResult = await requestForm('checkUser');
        if (Number(checkResult?.retCode) !== 100) {
            return { checkResult, redeemResult: null };
        }

        await new Promise((resolve) => {
            const delayMs = Math.floor(Math.random() * (config.actionDelayRangeMs.max - config.actionDelayRangeMs.min + 1)) + config.actionDelayRangeMs.min;
            window.setTimeout(resolve, delayMs);
        });

        const redeemResult = await requestForm('useCoupon');
        return { checkResult, redeemResult };
    }, {
        couponCode: coupon.code,
        config: {
            country: config.country,
            lang: config.lang,
            server: accountConfig.server,
            hiveId: accountConfig.hiveId,
            actionDelayRangeMs: config.actionDelayRangeMs
        }
    });
}

function createKvRecordStore() {
    return {
        loadAccount: (accountConfig) => loadKvAccountRecord(accountConfig),
        saveAccount: (accountConfig, recordAccount) => saveKvAccountRecord(accountConfig, recordAccount)
    };
}

async function loadKvAccountRecord(accountConfig) {
    const key = getAccountRecordKey(accountConfig);
    const response = await fetch(getKvValueUrl(key), {
        headers: getKvHeaders()
    });

    if (response.status === 404) {
        return createEmptyAccountRecord(accountConfig);
    }

    const text = await response.text();
    if (!response.ok) {
        throw new Error(`Cloudflare KV read failed for ${key} with HTTP ${response.status}: ${shortText(text)}`);
    }

    try {
        return normalizeAccountRecord(JSON.parse(text), accountConfig);
    } catch {
        throw new Error(`Cloudflare KV record ${key} contains invalid JSON: ${shortText(text)}`);
    }
}

async function saveKvAccountRecord(accountConfig, recordAccount) {
    const key = getAccountRecordKey(accountConfig);
    const next = normalizeAccountRecord(recordAccount, accountConfig);
    next.updatedAt = new Date().toISOString();

    const response = await fetch(getKvValueUrl(key), {
        method: 'PUT',
        headers: {
            ...getKvHeaders(),
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(next)
    });

    const text = await response.text();
    if (!response.ok) {
        throw new Error(`Cloudflare KV write failed for ${key} with HTTP ${response.status}: ${shortText(text)}`);
    }
}

function normalizeAccountRecord(record, accountConfig) {
    const next = record && typeof record === 'object' ? record : {};
    const accountKey = getAccountKey(accountConfig.hiveId, accountConfig.server);

    return {
        version: 1,
        updatedAt: next.updatedAt || null,
        server: accountConfig.server,
        hiveIdHash: accountKey,
        redeemed: next.redeemed && typeof next.redeemed === 'object' ? next.redeemed : {}
    };
}

function createEmptyAccountRecord(accountConfig) {
    return normalizeAccountRecord({}, accountConfig);
}

function getAccountRecordKey(accountConfig) {
    return `${config.kvKeyPrefix}:${getAccountKey(accountConfig.hiveId, accountConfig.server)}`;
}

function getKvValueUrl(key) {
    return `${CLOUDFLARE_API_BASE_URL}/accounts/${encodeURIComponent(config.kvAccountId)}/storage/kv/namespaces/${encodeURIComponent(config.kvNamespaceId)}/values/${encodeURIComponent(key)}`;
}

function getKvHeaders() {
    return {
        Authorization: `Bearer ${config.kvApiToken}`
    };
}

function createRecord(coupon, result, response, accountConfig) {
    return {
        code: coupon.code,
        server: accountConfig.server,
        result,
        redeemedAt: new Date().toISOString(),
        couponStatus: coupon.status,
        hiveRetCode: response?.retCode ?? null,
        hiveRetMsg: response?.retMsg ? String(response.retMsg).slice(0, 300) : null
    };
}

async function sendDiscordNotification(summary) {
    if (!config.discordWebhookUrl) {
        console.log('DISCORD_WEBHOOK_URL is not set; skipping Discord notification.');
        return;
    }

    try {
        const response = await fetch(config.discordWebhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: buildDiscordMessage(summary) })
        });

        if (!response.ok) {
            const text = await response.text();
            console.warn(`Discord notification failed with HTTP ${response.status}: ${shortText(text)}`);
        }
    } catch (error) {
        console.warn(`Discord notification failed: ${error.message}`);
    }
}

function buildDiscordMessage(summary) {
    const lines = [
        '**SW Coupon Redeemer**',
        `Accounts: ${summary.accounts.length}`,
        `Startup delay: ${summary.startDelayMs}ms`,
        `Fetched: ${summary.fetched}`,
        `Redeemed: ${totalCount(summary, 'redeemed')}`,
        `Already redeemed: ${totalCount(summary, 'alreadyRedeemed')}`,
        `Failed: ${totalCount(summary, 'failed')}`,
        `Record updated: ${summary.recordUpdated ? 'yes' : 'no'}`
    ];

    for (const account of summary.accounts) {
        lines.push('');
        lines.push(`Hive ID: ${account.hiveId}`);
        lines.push(`Server: ${account.server}`);
        lines.push(`Skipped from record: ${account.skippedRecorded}`);
        lines.push(`Redeemed: ${formatCodes(account.redeemed)}`);
        lines.push(`Already redeemed: ${formatCodes(account.alreadyRedeemed)}`);
        lines.push(`Failed: ${account.failed.length}`);

        if (account.dryRun.length) {
            lines.push(`Dry run queued: ${formatCodes(account.dryRun)}`);
        }

        if (account.failed.length) {
            lines.push('Failures:');
            for (const failure of account.failed.slice(0, 5)) {
                lines.push(`- ${failure.code} @ ${failure.stage}: ${failure.message}`);
            }
        }
    }

    if (summary.fatalError) {
        lines.push('');
        lines.push(`Fatal: ${summary.fatalError}`);
    }

    const message = lines.join('\n');
    return message.length <= 1900 ? message : `${message.slice(0, 1850)}\n...truncated`;
}

function createSummary() {
    return {
        fetched: 0,
        startDelayMs: 0,
        accounts: [],
        recordUpdated: false,
        fatalError: null
    };
}

function createAccountSummary(accountConfig) {
    return {
        hiveId: accountConfig.hiveId,
        server: accountConfig.server,
        skippedRecorded: 0,
        redeemed: [],
        alreadyRedeemed: [],
        failed: [],
        dryRun: []
    };
}

function logSummary(summary) {
    console.log([
        `Summary: fetched=${summary.fetched}`,
        `startDelayMs=${summary.startDelayMs}`,
        `accounts=${summary.accounts.length}`,
        `redeemed=${totalCount(summary, 'redeemed')}`,
        `alreadyRedeemed=${totalCount(summary, 'alreadyRedeemed')}`,
        `failed=${totalCount(summary, 'failed')}`,
        `recordUpdated=${summary.recordUpdated ? 'yes' : 'no'}`
    ].join(' '));
}

function totalCount(summary, field) {
    return summary.accounts.reduce((sum, account) => sum + account[field].length, 0);
}

function formatCodes(codes) {
    return codes.length ? codes.join(', ') : 'none';
}

function maskHiveId(hiveId) {
    const text = String(hiveId || '');
    if (text.length <= 4) {
        return '****';
    }

    return `${'*'.repeat(Math.max(4, text.length - 4))}${text.slice(-4)}`;
}

function toFailure(code, stage, response) {
    return {
        code,
        stage,
        retCode: response?.retCode ?? null,
        message: response?.retMsg ? String(response.retMsg).slice(0, 300) : JSON.stringify(response || {})
    };
}

function getAccountKey(hiveId, server) {
    return crypto.createHash('sha256').update(`${server}:${hiveId}`).digest('hex').slice(0, 16);
}

function isSuccess(response) {
    return response && Number(response.retCode) === 100;
}

function looksAlreadyRedeemed(response) {
    if (String(response?.retCode || '').toUpperCase().includes('H304')) {
        return true;
    }

    const message = String(response?.retMsg || '').toLowerCase();
    return /already|redeemed|used|duplicate|已|使用|兑换/.test(message);
}

function normalizeServer(server) {
    return String(server || 'china').trim().toLowerCase();
}

function parseAccounts() {
    const defaultServer = normalizeServer(process.env.SW_SERVER || process.env.SERVER || 'china');
    const rawAccounts = String(process.env.HIVE_ACCOUNTS || '').trim();

    if (rawAccounts) {
        return dedupeAccounts(parseAccountsValue(rawAccounts, defaultServer));
    }

    const rawIds = String(process.env.HIVE_IDS || process.env.HIVE_ID_LIST || '').trim();
    if (rawIds) {
        return dedupeAccounts(splitAccountList(rawIds).map((entry) => parseAccountEntry(entry, defaultServer)));
    }

    const hiveId = String(process.env.HIVE_ID || '').trim();
    return hiveId ? [{ hiveId, server: defaultServer }] : [];
}

function parseAccountsValue(value, defaultServer) {
    try {
        const parsed = JSON.parse(value);
        const accounts = Array.isArray(parsed) ? parsed : parsed?.accounts;

        if (Array.isArray(accounts)) {
            return accounts.map((entry) => parseAccountEntry(entry, defaultServer));
        }
    } catch {
        // Plain text lists are supported below.
    }

    return splitAccountList(value).map((entry) => parseAccountEntry(entry, defaultServer));
}

function parseAccountEntry(entry, defaultServer) {
    if (entry && typeof entry === 'object') {
        return {
            hiveId: String(entry.hiveId || entry.hiveID || entry.id || '').trim(),
            server: normalizeServer(entry.server || defaultServer)
        };
    }

    const text = String(entry || '').trim();
    const parts = text.split(/[:@|]/).map((part) => part.trim()).filter(Boolean);

    return {
        hiveId: parts[0] || '',
        server: normalizeServer(parts[1] || defaultServer)
    };
}

function splitAccountList(value) {
    return String(value || '')
        .split(/[\n,;]+/)
        .map((entry) => entry.trim())
        .filter(Boolean);
}

function dedupeAccounts(accounts) {
    const seen = new Set();
    const result = [];

    for (const account of accounts) {
        const key = `${account.server}:${account.hiveId}`;
        if (!account.hiveId || seen.has(key)) {
            continue;
        }

        seen.add(key);
        result.push(account);
    }

    return result;
}

function parseBoolean(value) {
    return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function parseDelayRange(value) {
    const text = String(value || '').trim();
    const rangeMatch = text.match(/^(\d+)\s*[-,~:]\s*(\d+)$/);

    if (rangeMatch) {
        const first = Number(rangeMatch[1]);
        const second = Number(rangeMatch[2]);

        return {
            min: Math.max(0, Math.min(first, second)),
            max: Math.max(0, Math.max(first, second))
        };
    }

    const base = Number(text);
    if (Number.isFinite(base) && base >= 0) {
        return {
            min: Math.max(0, Math.floor(base * 0.7)),
            max: Math.max(0, Math.ceil(base * 1.5))
        };
    }

    return {
        min: 4500,
        max: 12000
    };
}

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function shortText(value) {
    return String(value || '').replace(/\s+/g, ' ').slice(0, 500);
}

main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
