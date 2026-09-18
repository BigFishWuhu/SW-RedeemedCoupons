const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AppDatabase } = require('../lib/database');
const { checkForNewCoupons } = require('../lib/coupon-checker');

function database(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'swcoupon-check-'));
    const db = new AppDatabase(path.join(directory, 'test.sqlite'));
    t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    return db;
}

test('returns only newly discovered coupons that still need redemption', async (t) => {
    const db = database(t);
    const account = db.createAccount({ name: 'Test', hiveId: 'player', server: 'global', enabled: true });
    const jobId = db.createJob('manual', account.id);
    db.addRecord(jobId, account, 'OLD-CODE', { status: 'redeemed', stage: 'useCoupon', retCode: 100, message: 'OK' });
    db.finishJob(jobId, { fetched: 1, success: 1, skipped: 0, failed: 0 });

    const first = await checkForNewCoupons({ db, fetchCoupons: async () => ['OLD-CODE', 'NEW-CODE'] });
    assert.deepEqual(first, { fetched: 2, newCount: 2, pending: 1, pendingCodes: ['NEW-CODE'] });
    db.addRecord(jobId, account, 'NEW-CODE', { status: 'redeemed', stage: 'useCoupon', retCode: 100, message: 'OK' });
    const second = await checkForNewCoupons({ db, fetchCoupons: async () => ['OLD-CODE', 'NEW-CODE'] });
    assert.deepEqual(second, { fetched: 2, newCount: 0, pending: 0, pendingCodes: [] });
});

test('records failed checks and does not need a browser', async (t) => {
    const db = database(t);
    db.createAccount({ name: 'Test', hiveId: 'player', server: 'global', enabled: true });
    await assert.rejects(
        () => checkForNewCoupons({ db, fetchCoupons: async () => { throw new Error('SWGT unavailable'); } }),
        /SWGT unavailable/
    );
    assert.equal(db.latestCouponCheck().status, 'failed');
    assert.equal(db.latestCouponCheck().error, 'SWGT unavailable');
});
