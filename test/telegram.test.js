const assert = require('node:assert/strict');
const test = require('node:test');
const { sendTelegramMessage, buildJobMessage } = require('../lib/telegram');

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

test('builds a concise redemption summary', () => {
    const message = buildJobMessage({
        summary: { fetched: 3, success: 2, skipped: 1, failed: 0 },
        triggerType: 'schedule', startedAt: '2026-09-08T04:00:00.000Z', timezone: 'Asia/Shanghai'
    });
    assert.match(message, /定时任务/);
    assert.match(message, /兑换成功：2/);
    assert.match(message, /已跳过：1/);
});
