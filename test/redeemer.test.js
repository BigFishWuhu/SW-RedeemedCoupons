const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AppDatabase } = require('../lib/database');
const { classifyResponse, runRedemption } = require('../lib/redeemer');

test('classifies Hive responses', () => {
    assert.equal(classifyResponse({ retCode: 100 }, { retCode: 100 }).status, 'redeemed');
    assert.equal(classifyResponse({ retCode: 'H304', retMsg: 'already used' }, null).status, 'already-redeemed');
    assert.equal(classifyResponse({ retCode: 100 }, { retCode: 500, retMsg: 'nope' }).status, 'failed');
});

test('runs redemption and skips previously successful coupons', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'swcoupon-redeem-'));
    const db = new AppDatabase(path.join(directory, 'test.sqlite'));
    t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const account = db.createAccount({ name: 'Test', hiveId: 'player', server: 'global', enabled: true });
    let attempts = 0;
    const options = {
        fetchCoupons: async () => ['CODE1', 'CODE2'],
        createRedeemer: async () => ({
            redeem: async () => { attempts += 1; return { checkResult: { retCode: 100 }, redeemResult: { retCode: 100, retMsg: 'OK' } }; },
            close: async () => {}
        }),
        redeemDelayMs: { min: 0, max: 0 }
    };
    const first = await runRedemption({ db, accountId: account.id, options });
    assert.deepEqual({ success: first.success, skipped: first.skipped, failed: first.failed }, { success: 2, skipped: 0, failed: 0 });
    const second = await runRedemption({ db, accountId: account.id, options });
    assert.deepEqual({ success: second.success, skipped: second.skipped }, { success: 0, skipped: 2 });
    assert.equal(attempts, 2);
});
