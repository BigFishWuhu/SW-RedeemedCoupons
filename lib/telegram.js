async function sendTelegramMessage(config, text, options = {}) {
    if (!config?.botToken || !config?.chatId) {
        throw new Error('Telegram Bot Token 或 Chat ID 未配置');
    }
    const fetchImpl = options.fetchImpl || fetch;
    const response = await fetchImpl(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: config.chatId,
            text: String(text).slice(0, 4096),
            disable_web_page_preview: true
        }),
        signal: options.signal || AbortSignal.timeout(15_000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
        throw new Error(`Telegram 推送失败：${String(data.description || `HTTP ${response.status}`).slice(0, 300)}`);
    }
    return data;
}

async function setTelegramWebhook(config, options = {}) {
    if (!config?.botToken) throw new Error('Telegram Bot Token 未配置');
    if (!config?.webhookUrl || !config?.webhookSecret) throw new Error('Telegram Webhook 配置不完整');
    const fetchImpl = options.fetchImpl || fetch;
    const response = await fetchImpl(`https://api.telegram.org/bot${config.botToken}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            url: `${config.webhookUrl.replace(/\/+$/, '')}/api/telegram/webhook`,
            secret_token: config.webhookSecret,
            allowed_updates: ['message'],
            drop_pending_updates: options.dropPendingUpdates === true
        }),
        signal: options.signal || AbortSignal.timeout(15_000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
        throw new Error(`Telegram Webhook 注册失败：${String(data.description || `HTTP ${response.status}`).slice(0, 300)}`);
    }
    const commandsResponse = await fetchImpl(`https://api.telegram.org/bot${config.botToken}/setMyCommands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commands: [
            { command: 'redeem', description: '立即兑换全部启用账号' },
            { command: 'records', description: '查询最近兑换记录' }
        ] }),
        signal: options.signal || AbortSignal.timeout(15_000)
    });
    const commandsData = await commandsResponse.json().catch(() => ({}));
    if (!commandsResponse.ok || commandsData.ok === false) {
        throw new Error(`Telegram 命令菜单注册失败：${String(commandsData.description || `HTTP ${commandsResponse.status}`).slice(0, 300)}`);
    }
    return data;
}

async function deleteTelegramWebhook(config, options = {}) {
    if (!config?.botToken) return;
    const fetchImpl = options.fetchImpl || fetch;
    const response = await fetchImpl(`https://api.telegram.org/bot${config.botToken}/deleteWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drop_pending_updates: true }),
        signal: options.signal || AbortSignal.timeout(15_000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
        throw new Error(`Telegram Webhook 删除失败：${String(data.description || `HTTP ${response.status}`).slice(0, 300)}`);
    }
    return data;
}

function parseTelegramCommand(update, allowedChatId) {
    const message = update?.message;
    const allowed = String(allowedChatId || '').toLowerCase();
    const actualId = String(message?.chat?.id || '');
    const actualUsername = message?.chat?.username ? `@${String(message.chat.username).toLowerCase()}` : '';
    if (!message || (actualId !== allowed && actualUsername !== allowed)) return null;
    const match = String(message.text || '').trim().match(/^\/(redeem|records)(?:@[A-Za-z0-9_]+)?(?:\s+(.*))?$/i);
    if (!match) return null;
    return { name: match[1].toLowerCase(), argument: String(match[2] || '').trim() };
}

function buildRecordsMessage(records, timezone = 'Asia/Shanghai') {
    if (!records.length) return 'SW Coupon Console\n\n暂无匹配的兑换记录。';
    const statusLabels = { redeemed: '成功', 'already-redeemed': '已兑换', failed: '失败' };
    const lines = ['SW Coupon Console', `最近兑换记录（${records.length} 条）`, ''];
    for (const record of records) {
        lines.push([
            `${statusLabels[record.status] || record.status} · ${record.couponCode}`,
            `账号：${record.accountName || record.hiveId}（${record.hiveId}）`,
            `时间：${formatTime(record.createdAt, timezone)}`
        ].join('\n'));
        lines.push('');
    }
    return lines.join('\n').trim();
}

function buildJobMessage({ summary, triggerType, error, startedAt, timezone = 'Asia/Shanghai', couponCodes = [] }) {
    const triggerLabel = triggerType === 'interval' ? '定时新兑换码检查'
        : triggerType === 'telegram' ? 'Telegram 命令' : '手动任务';
    const statusLabel = error ? '❌ 执行失败' : summary.failed > 0 ? '⚠️ 执行完成（存在失败）' : '✅ 执行完成';
    const lines = [
        'SW Coupon Console',
        statusLabel,
        '',
        `类型：${triggerLabel}`,
        `开始时间：${formatTime(startedAt, timezone)}`,
        `发现兑换码：${Number(summary.fetched || 0)}`,
        `兑换成功：${Number(summary.success || 0)}`,
        `已跳过：${Number(summary.skipped || 0)}`,
        `兑换失败：${Number(summary.failed || 0)}`
    ];
    if (couponCodes.length) lines.push(`兑换码：${couponCodes.join('、')}`);
    if (error) lines.push('', `错误：${String(error).slice(0, 500)}`);
    return lines.join('\n');
}

function formatTime(value, timezone) {
    try {
        return new Intl.DateTimeFormat('zh-CN', {
            timeZone: timezone, dateStyle: 'medium', timeStyle: 'medium', hour12: false
        }).format(value ? new Date(value) : new Date());
    } catch {
        return String(value || '未知');
    }
}

module.exports = {
    sendTelegramMessage, setTelegramWebhook, deleteTelegramWebhook,
    parseTelegramCommand, buildRecordsMessage, buildJobMessage
};
