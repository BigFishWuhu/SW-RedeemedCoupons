const assert = require('node:assert/strict');
const test = require('node:test');
const {
    sendTelegramMessage, setTelegramWebhook, deleteTelegramWebhook,
    parseTelegramCommand, buildRecordsMessage, buildJobMessage
} = require('../lib/telegram');

test('sends Telegram messages with the configured chat', async () => {
    let request;
    const result = await sendTelegramMessage(
        { botToken: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd', chatId: '-1001234567890' },
        'hello',
        {
            fetchImpl: async (url, options) => {
                request = { url, options };
                return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
                    status: 200, headers: { 'Content-Type': 'application/json' }
                });
            }
        }
    );
    assert.equal(result.ok, true);
    assert.match(request.url, /\/sendMessage$/);
    assert.deepEqual(JSON.parse(request.options.body), {
        chat_id: '-1001234567890', text: 'hello', disable_web_page_preview: true
    });
});

test('reports Telegram API errors without exposing the request URL', async () => {
    await assert.rejects(() => sendTelegramMessage(
        { botToken: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd', chatId: '123' },
        'hello',
        { fetchImpl: async () => new Response(JSON.stringify({ ok: false, description: 'chat not found' }), { status: 400 }) }
    ), /chat not found/);
});

test('registers and deletes a secure Telegram webhook', async () => {
    const requests = [];
    const fetchImpl = async (url, options) => {
        requests.push({ url, body: JSON.parse(options.body) });
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    };
    const config = {
        botToken: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd',
        webhookUrl: 'https://coupon.example.com', webhookSecret: 'secret_token'
    };
    await setTelegramWebhook(config, { fetchImpl, dropPendingUpdates: true });
    await deleteTelegramWebhook(config, { fetchImpl });
    assert.match(requests[0].url, /\/setWebhook$/);
    assert.deepEqual(requests[0].body, {
        url: 'https://coupon.example.com/api/telegram/webhook', secret_token: 'secret_token',
        allowed_updates: ['message'], drop_pending_updates: true
    });
    assert.match(requests[1].url, /\/setMyCommands$/);
    assert.deepEqual(requests[1].body.commands.map((item) => item.command), ['redeem', 'records']);
    assert.match(requests[2].url, /\/deleteWebhook$/);
});

test('accepts commands only from the configured Telegram chat', () => {
    const update = { message: { chat: { id: -100123 }, text: '/records 20' } };
    assert.deepEqual(parseTelegramCommand(update, '-100123'), { name: 'records', argument: '20' });
    assert.equal(parseTelegramCommand(update, '-100999'), null);
    assert.deepEqual(parseTelegramCommand({ message: { chat: { id: 1 }, text: '/redeem@coupon_bot' } }, '1'), {
        name: 'redeem', argument: ''
    });
});

test('builds Telegram redemption record messages', () => {
    const text = buildRecordsMessage([{
        status: 'redeemed', couponCode: 'HELLO', accountName: 'Main', hiveId: 'player',
        createdAt: '2026-09-19 02:00:00'
    }], 'Asia/Shanghai');
    assert.match(text, /HELLO/);
    assert.match(text, /Main/);
    assert.match(buildRecordsMessage([]), /暂无匹配/);
});

test('builds a concise redemption summary', () => {
    const message = buildJobMessage({
        summary: { fetched: 3, success: 2, skipped: 1, failed: 0 },
        triggerType: 'manual', startedAt: '2026-09-08T04:00:00.000Z', timezone: 'Asia/Shanghai'
    });
    assert.match(message, /手动任务/);
    assert.match(message, /兑换成功：2/);
    assert.match(message, /已跳过：1/);
    assert.match(buildJobMessage({
        summary: {}, triggerType: 'interval', startedAt: '2026-09-08T04:00:00.000Z', couponCodes: ['NEW-CODE']
    }), /定时新兑换码检查/);
    assert.match(buildJobMessage({ summary: {}, triggerType: 'interval', couponCodes: ['NEW-CODE'] }), /兑换码：NEW-CODE/);
});
