async function checkForNewCoupons({ db, fetchCoupons, triggerType = 'interval' }) {
    let fetched = 0;
    let newCount = 0;
    let pending = 0;
    try {
        const accounts = db.listAccounts(true);
        if (!accounts.length) throw new Error('没有可用的兑换账号');

        const coupons = await fetchCoupons();
        fetched = coupons.length;
        const newCodes = db.discoverCoupons(coupons);
        newCount = newCodes.length;
        const pendingCodes = newCodes.filter((code) =>
            accounts.some((account) => !db.hasSuccessfulRecord(account.id, code))
        );
        pending = pendingCodes.length;
        db.addCouponCheck({ triggerType, fetched, newCount, pending });
        return { fetched, newCount, pending, pendingCodes };
    } catch (error) {
        db.addCouponCheck({ triggerType, fetched, newCount, pending, error: error.message });
        throw error;
    }
}

module.exports = { checkForNewCoupons };
