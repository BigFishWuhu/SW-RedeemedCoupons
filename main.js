// ==UserScript==
// @name         Summoners War Coupon Auto Redeemer
// @namespace    https://swgt.io/
// @version      1.1.0
// @description  Auto-fill Hive ID/server and redeem all available coupon codes from SWGT
// @match        https://event.withhive.com/ci/smon/evt_coupon*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      swgt.io
// @connect      event.withhive.com
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    const CODE_LIST_URL = 'https://swgt.io/controllers/dashboard/loadSummonersWarGameCodes';
    const DEFAULTS = {
        hiveId: '',
        server: 'china',
        delayMs: 1200,
        autoStart: false
    };

    const SERVER_LABELS = {
        global: 'Global Server',
        korea: 'Korea Server',
        japan: 'Japan Server',
        china: 'China Server',
        asia: 'Asia Server',
        europe: 'Europe Server'
    };

    const state = {
        running: false,
        queue: [],
        index: 0,
        success: 0,
        fail: 0,
        skipped: 0,
        currentCode: '',
        logs: []
    };

    const ui = {};

    function getConfig() {
        return {
            hiveId: String(GM_getValue('hiveId', DEFAULTS.hiveId) || '').trim(),
            server: String(GM_getValue('server', DEFAULTS.server) || DEFAULTS.server).trim(),
            delayMs: Number(GM_getValue('delayMs', DEFAULTS.delayMs) || DEFAULTS.delayMs),
            autoStart: Boolean(GM_getValue('autoStart', DEFAULTS.autoStart))
        };
    }

    function saveConfig(next) {
        GM_setValue('hiveId', String(next.hiveId || '').trim());
        GM_setValue('server', String(next.server || DEFAULTS.server).trim());
        GM_setValue('delayMs', Math.max(0, Number(next.delayMs) || DEFAULTS.delayMs));
        GM_setValue('autoStart', Boolean(next.autoStart));
    }

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function requestText(url, method = 'GET', data = null) {
        return new Promise((resolve, reject) => {
            addLog(`HTTP ${method} ${url}`);
            GM_xmlhttpRequest({
                method,
                url,
                data: data ? JSON.stringify(data) : null,
                headers: data ? { 'Content-Type': 'application/json' } : undefined,
                withCredentials: true,
                responseType: 'text',
                onload: (res) => {
                    addLog(`HTTP ${res.status} ${url}`);
                    if (res.status < 200 || res.status >= 300) {
                        reject(new Error(`Request failed: ${url} (${res.status})`));
                        return;
                    }
                    resolve(res.responseText);
                },
                onerror: (err) => {
                    addLog(`HTTP error ${url}: ${JSON.stringify(err || {})}`);
                    reject(new Error(`Request failed: ${url}`));
                }
            });
        });
    }

    function requestForm(url, data) {
        const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        const relativeUrl = url.replace(/^https:\/\/event\.withhive\.com\/ci\/smon\//, '');

        if (pageWindow.jQuery && typeof pageWindow.jQuery.ajax === 'function') {
            addLog(`PAGE AJAX POST ${relativeUrl} coupon=${data.coupon || ''} server=${data.server || ''}`);
            return new Promise((resolve, reject) => {
                pageWindow.jQuery.ajax({
                    url: relativeUrl,
                    dataType: 'JSON',
                    type: 'post',
                    data,
                    success: (res) => {
                        addLog(`PAGE AJAX OK ${relativeUrl}: ${shortText(JSON.stringify(res || {}))}`);
                        resolve(res);
                    },
                    error: (xhr, status, err) => {
                        addLog(`PAGE AJAX ${xhr?.status || status} ${relativeUrl}: ${shortText(xhr?.responseText || err || status)}`);
                        reject(new Error(`Request failed: ${relativeUrl} (${xhr?.status || status})`));
                    }
                });
            });
        }

        const body = new URLSearchParams(data).toString();
        return new Promise((resolve, reject) => {
            addLog(`FETCH POST ${relativeUrl} coupon=${data.coupon || ''} server=${data.server || ''}`);
            fetch(relativeUrl, {
                method: 'POST',
                body,
                credentials: 'same-origin',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'Accept': 'application/json, text/javascript, */*; q=0.01',
                    'X-Requested-With': 'XMLHttpRequest'
                }
            })
                .then(async (res) => {
                    const text = await res.text();
                    addLog(`FETCH ${res.status} ${relativeUrl}: ${shortText(text)}`);
                    if (!res.ok) {
                        throw new Error(`Request failed: ${relativeUrl} (${res.status})`);
                    }
                    try {
                        resolve(JSON.parse(text));
                    } catch (err) {
                        reject(new Error(`Invalid JSON from ${relativeUrl}`));
                    }
                })
                .catch(reject);
        });
    }

    function ensurePanel() {
        if (document.getElementById('swca-panel')) {
            return;
        }

        const panel = document.createElement('div');
        panel.id = 'swca-panel';
        panel.style.cssText = [
            'position:fixed',
            'right:16px',
            'bottom:16px',
            'z-index:999999',
            'width:300px',
            'background:#111',
            'color:#fff',
            'border:1px solid rgba(255,255,255,.18)',
            'border-radius:8px',
            'padding:12px',
            'font:13px/1.4 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
            'box-shadow:0 8px 24px rgba(0,0,0,.35)'
        ].join(';');

        panel.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;">
                <strong style="font-size:13px;">SW Coupon Auto</strong>
                <span id="swca-status" style="font-size:12px;color:#9ad;">idle</span>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px;">
                <button id="swca-start" type="button" style="padding:8px;border:0;border-radius:6px;background:#2d6cdf;color:#fff;cursor:pointer;">Start</button>
                <button id="swca-stop" type="button" style="padding:8px;border:0;border-radius:6px;background:#555;color:#fff;cursor:pointer;">Stop</button>
            </div>
            <button id="swca-copy-log" type="button" style="width:100%;padding:7px;border:0;border-radius:6px;background:#333;color:#fff;cursor:pointer;margin-bottom:8px;">Copy log</button>
            <div id="swca-info" style="font-size:12px;white-space:pre-wrap;word-break:break-word;color:#ddd;min-height:72px;max-height:220px;overflow:auto;"></div>
        `;
        document.body.appendChild(panel);

        ui.panel = panel;
        ui.status = panel.querySelector('#swca-status');
        ui.info = panel.querySelector('#swca-info');
        panel.querySelector('#swca-start').addEventListener('click', () => startRedeemFlow());
        panel.querySelector('#swca-stop').addEventListener('click', () => stopRedeemFlow());
        panel.querySelector('#swca-copy-log').addEventListener('click', () => copyLogs());
    }

    function setStatus(text) {
        if (ui.status) {
            ui.status.textContent = text;
        }
    }

    function setInfo(text) {
        if (ui.info) {
            ui.info.textContent = text;
        }
    }

    function shortText(text) {
        return String(text || '').replace(/\s+/g, ' ').slice(0, 500);
    }

    function addLog(message) {
        const line = `[${new Date().toLocaleTimeString()}] ${message}`;
        state.logs.push(line);
        if (state.logs.length > 300) {
            state.logs.shift();
        }
        console.log(`[SW Coupon Auto] ${message}`);
    }

    async function copyLogs() {
        const text = state.logs.join('\n') || 'No logs yet.';
        try {
            await navigator.clipboard.writeText(text);
            setInfo(`Copied logs.\n\n${text.slice(-900)}`);
        } catch (err) {
            setInfo(`Copy failed. Select manually:\n\n${text.slice(-1200)}`);
        }
    }

    function renderProgress(extra = '') {
        const summary = [
            extra,
            `Progress: ${state.index}/${state.queue.length}`,
            `Current: ${state.currentCode || 'n/a'}`,
            `Success: ${state.success}`,
            `Fail: ${state.fail}`,
            `Skipped: ${state.skipped}`,
            '',
            'Recent log:',
            ...state.logs.slice(-8)
        ].filter((line) => line !== null && line !== undefined).join('\n');
        setInfo(summary);
    }

    function openConfig() {
        const cfg = getConfig();
        const hiveId = prompt('Hive ID', cfg.hiveId);
        if (hiveId === null) {
            return;
        }

        const server = prompt('Server: global / korea / japan / china / asia / europe', cfg.server);
        if (server === null) {
            return;
        }

        const delayMs = prompt('Delay between codes (ms)', String(cfg.delayMs));
        if (delayMs === null) {
            return;
        }

        const autoStart = confirm('Auto start when page opens?');

        saveConfig({
            hiveId,
            server: normalizeServer(server),
            delayMs: Number(delayMs) || DEFAULTS.delayMs,
            autoStart
        });

        syncFormFields();
        setInfo(`Saved.\nHive ID: ${String(hiveId || '').trim()}\nServer: ${normalizeServer(server)}`);
    }

    function normalizeServer(server) {
        const key = String(server || '').trim().toLowerCase();
        if (SERVER_LABELS[key]) {
            return key;
        }

        const match = Object.keys(SERVER_LABELS).find((k) => SERVER_LABELS[k].toLowerCase() === key);
        return match || DEFAULTS.server;
    }

    function syncFormFields() {
        const cfg = getConfig();
        const serverSelect = document.querySelector('#EVTselect');
        const hiveInput = document.querySelector('#EVTid');

        if (serverSelect && cfg.server) {
            serverSelect.value = cfg.server;
            if (window.jQuery && typeof window.jQuery.fn.selectmenu === 'function') {
                try {
                    window.jQuery(serverSelect).selectmenu('refresh');
                } catch (err) {
                    // ignore
                }
            }
        }

        if (hiveInput && cfg.hiveId) {
            hiveInput.value = cfg.hiveId;
        }
    }

    async function fetchCoupons() {
        addLog('Fetching coupon list');
        const html = await requestText(CODE_LIST_URL);
        const codePattern = /\bdata-clipboard-text\s*=\s*(["'])([^"']+)\1/gi;
        const codes = new Set();
        let match;

        while ((match = codePattern.exec(html)) !== null) {
            const code = match[2].trim().toUpperCase();
            if (code) {
                codes.add(code);
            }
        }

        return Array.from(codes);
    }

    async function checkUserAndRedeem(code) {
        const cfg = getConfig();
        const payload = {
            country: 'NL',
            lang: 'en',
            server: cfg.server,
            hiveid: cfg.hiveId,
            coupon: code
        };

        addLog(`Checking ${code}`);
        const checkRes = await requestForm('evt_coupon/checkUser', payload);
        if (!checkRes || checkRes.retCode !== 100) {
            addLog(`Check failed ${code}: ${JSON.stringify(checkRes || {})}`);
            return { ok: false, stage: 'check', response: checkRes };
        }

        addLog(`Redeeming ${code}`);
        const useRes = await requestForm('evt_coupon/useCoupon', payload);
        if (!useRes || useRes.retCode !== 100) {
            addLog(`Redeem failed ${code}: ${JSON.stringify(useRes || {})}`);
            return { ok: false, stage: 'use', response: useRes };
        }

        addLog(`Redeemed ${code}`);
        return { ok: true, response: useRes };
    }

    async function startRedeemFlow() {
        if (state.running) {
            return;
        }

        const cfg = getConfig();
        if (!cfg.hiveId) {
            alert('先在配置里填写 Hive ID。');
            openConfig();
            return;
        }

        state.running = true;
        state.success = 0;
        state.fail = 0;
        state.skipped = 0;
        state.index = 0;
        state.queue = [];
        state.logs = [];
        addLog('Started');

        syncFormFields();
        setStatus('loading');
        renderProgress('Loading coupons from SWGT ...');

        try {
            state.queue = await fetchCoupons();
            addLog(`Loaded ${state.queue.length} redeemable codes`);
            if (!state.queue.length) {
                renderProgress('No redeemable coupons found.');
                setStatus('idle');
                state.running = false;
                return;
            }

            renderProgress(`Loaded ${state.queue.length} codes. Starting redemption...`);

            for (state.index = 0; state.index < state.queue.length; state.index += 1) {
                if (!state.running) {
                    break;
                }

                const code = state.queue[state.index];
                state.currentCode = code;
                setStatus(`${state.index + 1}/${state.queue.length}`);
                renderProgress(`Running ${code}`);

                try {
                    const result = await checkUserAndRedeem(code);
                    if (result.ok) {
                        state.success += 1;
                        renderProgress(`Redeemed: ${code}`);
                    } else {
                        state.fail += 1;
                        const msg = result.response?.retMsg || JSON.stringify(result.response || {});
                        renderProgress(`Failed: ${code}\nStage: ${result.stage}\n${msg}`);
                    }
                } catch (err) {
                    state.fail += 1;
                    addLog(`Exception ${code}: ${err.stack || err.message}`);
                    renderProgress(`Failed: ${code}\n${err.message}`);
                }

                if (state.running && state.index < state.queue.length - 1) {
                    await sleep(getConfig().delayMs);
                }
            }

            setStatus('done');
            addLog('Done');
            renderProgress('Done.');
        } finally {
            state.running = false;
            if (ui.status && ui.status.textContent !== 'done') {
                setStatus('idle');
            }
        }
    }

    function stopRedeemFlow() {
        state.running = false;
        setStatus('stopped');
        setInfo(`Stopped at ${state.currentCode || 'n/a'}.\nSuccess: ${state.success}\nFail: ${state.fail}`);
    }

    function initMenu() {
        if (typeof GM_registerMenuCommand !== 'function') {
            return;
        }

        GM_registerMenuCommand('SW Coupon: Open config', openConfig);
        GM_registerMenuCommand('SW Coupon: Start redeem all', startRedeemFlow);
        GM_registerMenuCommand('SW Coupon: Stop', stopRedeemFlow);
    }

    function init() {
        ensurePanel();
        initMenu();
        syncFormFields();
        setStatus('idle');
        const cfg = getConfig();
        setInfo(
            `Hive ID: ${cfg.hiveId || '(not set)'}\n` +
            `Server: ${cfg.server} (${SERVER_LABELS[cfg.server] || cfg.server})\n` +
            `Delay: ${cfg.delayMs}ms\n` +
            `Auto start: ${cfg.autoStart ? 'on' : 'off'}`
        );

        if (cfg.autoStart) {
            startRedeemFlow();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
    window.addEventListener('load', syncFormFields);
})();
