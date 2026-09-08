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
