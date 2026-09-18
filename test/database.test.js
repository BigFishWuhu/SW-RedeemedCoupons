const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AppDatabase } = require('../lib/database');

function database(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'swcoupon-test-'));
    const db = new AppDatabase(path.join(directory, 'test.sqlite'));
    t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    return db;
}

test('initializes admin and authenticates sessions', (t) => {
    const db = database(t);
    assert.equal(db.needsSetup(), true);
    assert.equal(db.initializeAdmin('admin', ''), false);
    assert.equal(db.initializeAdmin('admin', 'a-secure-password'), true);
    assert.equal(db.needsSetup(), false);
    assert.equal(db.initializeAdmin('ignored', 'another-password'), false);
    assert.equal(db.authenticate('admin', 'wrong'), null);
    const user = db.authenticate('admin', 'a-secure-password');
    assert.equal(user.username, 'admin');
    const session = db.createSession(user.id);
    assert.equal(db.getSession(session.token).username, 'admin');
    db.deleteSession(session.token);
    assert.equal(db.getSession(session.token), null);
});

test('creates the first administrator interactively only once', (t) => {
    const db = database(t);
    const user = db.createInitialAdmin('owner', 'interactive-password');
    assert.deepEqual({ username: user.username, needsSetup: db.needsSetup() }, { username: 'owner', needsSetup: false });
    assert.throws(() => db.createInitialAdmin('second', 'another-password'), /已经创建/);
});

test('stores Telegram configuration without discarding an existing token', (t) => {
    const db = database(t);
    const token = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd';
    const saved = db.saveTelegramConfig({ botToken: token, chatId: '-1001234567890', enabled: true });
    assert.deepEqual(saved, { botToken: token, chatId: '-1001234567890', enabled: true });
    const updated = db.saveTelegramConfig({ botToken: '', chatId: '987654321', enabled: false });
    assert.equal(updated.botToken, token);
    assert.equal(updated.chatId, '987654321');
    assert.equal(db.getTelegramConfig().enabled, false);
    assert.throws(() => db.saveTelegramConfig({ clearToken: true, chatId: '', enabled: true }), /Bot Token/);
});

test('stores and validates automation schedule and random delays', (t) => {
    const db = database(t);
    const defaults = {
        enabled: true, scheduleTime: '12:00', timezone: 'Asia/Shanghai',
        redeemDelayMinMs: 4500, redeemDelayMaxMs: 12000,
        actionDelayMinMs: 800, actionDelayMaxMs: 2200,
        intervalHours: 1
    };
    assert.deepEqual(db.getAutomationConfig(defaults), defaults);
    const saved = db.saveAutomationConfig({
        enabled: false, scheduleTime: '23:35', timezone: 'UTC',
        redeemDelayMinMs: 2000, redeemDelayMaxMs: 7000,
        actionDelayMinMs: 300, actionDelayMaxMs: 900,
        intervalHours: 6
    }, defaults);
    assert.equal(saved.scheduleTime, '23:35');
    assert.equal(saved.timezone, 'UTC');
    assert.equal(saved.redeemDelayMaxMs, 7000);
    assert.equal(saved.intervalHours, 6);
    assert.equal(db.getAutomationConfig(defaults).enabled, false);
    assert.throws(() => db.saveAutomationConfig({ redeemDelayMinMs: 9000, redeemDelayMaxMs: 1000 }, defaults), /最小值/);
    assert.throws(() => db.saveAutomationConfig({ timezone: 'Not\/A-Timezone' }, defaults), /时区/);
    for (const intervalHours of [0, 169, 1.5, 'invalid']) {
        assert.throws(() => db.saveAutomationConfig({ intervalHours }, defaults), /1–168/);
    }
});

test('tracks newly discovered coupons and coupon checks', (t) => {
    const db = database(t);
    assert.deepEqual(db.discoverCoupons([' code1 ', 'CODE2', 'Code1', '']), ['CODE1', 'CODE2']);
    assert.deepEqual(db.discoverCoupons(['CODE1', 'code2']), []);
    assert.deepEqual(db.discoverCoupons(['CODE3']), ['CODE3']);

    db.addCouponCheck({ triggerType: 'interval', fetched: 3, newCount: 1, pending: 1 });
    const latest = db.latestCouponCheck();
    assert.deepEqual({ ...latest }, {
        triggerType: 'interval', status: 'completed', fetched: 3,
        newCount: 1, pending: 1, error: null,
        checkedAt: latest.checkedAt
    });
    db.addCouponCheck({ triggerType: 'manual', error: 'network error' });
    assert.equal(db.latestCouponCheck().status, 'failed');
    assert.equal(db.latestCouponCheck().error, 'network error');
});

test('manages accounts and keeps record snapshots after deletion', (t) => {
    const db = database(t);
    const account = db.createAccount({ name: '主账号', hiveId: 'player-1', server: 'china', enabled: true });
    assert.equal(db.listAccounts().length, 1);
    const updated = db.updateAccount(account.id, { ...account, name: '新备注', enabled: false });
    assert.equal(updated.name, '新备注');
    assert.equal(updated.enabled, false);
    const jobId = db.createJob('manual', account.id);
    db.addRecord(jobId, updated, 'HELLO2026', { status: 'redeemed', stage: 'useCoupon', retCode: 100, message: 'OK' });
    db.finishJob(jobId, { fetched: 1, success: 1, skipped: 0, failed: 0 });
    assert.equal(db.hasSuccessfulRecord(account.id, 'HELLO2026'), true);
    assert.equal(db.deleteAccount(account.id), true);
    const records = db.listRecords();
    assert.equal(records.total, 1);
    assert.equal(records.items[0].accountName, '新备注');
    assert.equal(records.items[0].accountId, null);
});

test('enforces monthly, yearly, and permanent account service validity', (t) => {
    const db = database(t);
    const monthly = db.createAccount({ name: 'Monthly', hiveId: 'monthly-id', server: 'global', servicePlan: 'monthly' });
    const yearly = db.createAccount({ name: 'Yearly', hiveId: 'yearly-id', server: 'global', servicePlan: 'yearly' });
    const permanent = db.createAccount({ name: 'Permanent', hiveId: 'permanent-id', server: 'global', servicePlan: 'permanent' });
    assert.match(monthly.serviceExpiresOn, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(yearly.serviceExpiresOn, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(permanent.serviceExpiresOn, null);
    db.db.prepare("UPDATE accounts SET service_expires_on = '2000-01-01' WHERE id = ?").run(monthly.id);
    assert.equal(db.getAccount(monthly.id).serviceActive, false);
    assert.deepEqual(db.listAccounts(true).map((account) => account.id).sort(), [yearly.id, permanent.id].sort());
    const renewed = db.updateAccount(yearly.id, { ...yearly, servicePlan: 'monthly', renewService: true });
    assert.equal(renewed.servicePlan, 'monthly');
    assert.equal(renewed.serviceActive, true);
});

test('finds accounts by internal account ID or Hive ID fragment', (t) => {
    const db = database(t);
    const first = db.createAccount({ name: 'First', hiveId: 'player-abc-001', server: 'global' });
    db.createAccount({ name: 'Second', hiveId: 'player-xyz-002', server: 'global' });
    assert.deepEqual(db.listAccounts(false, 'abc').map((account) => account.hiveId), ['player-abc-001']);
    assert.deepEqual(db.listAccounts(false, String(first.id)).map((account) => account.id), [first.id]);
});
