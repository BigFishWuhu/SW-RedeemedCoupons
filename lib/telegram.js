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

function buildJobMessage({ summary, triggerType, error, startedAt, timezone = 'Asia/Shanghai' }) {
    const triggerLabel = triggerType === 'schedule' ? '定时任务' : '手动任务';
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

module.exports = { sendTelegramMessage, buildJobMessage };
