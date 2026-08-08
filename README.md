# SW Coupon GitHub Action

This repository redeems Summoners War coupon codes from the sw-coupons feed on a GitHub Actions schedule.

Redemption runs through Playwright on the official Hive coupon page instead of calling Hive coupon endpoints directly from Node.

## GitHub Settings

Add these repository secrets:

- `HIVE_ACCOUNTS`: recommended for multiple accounts. Use JSON such as `[{"hiveId":"your_hive_id","server":"china"},{"hiveId":"second_hive_id","server":"global"}]`.
- `HIVE_IDS`: optional simple multi-account list using the same server, such as `your_hive_id,second_hive_id`.
- `HIVE_ID`: single-account fallback Hive ID.
- `CLOUDFLARE_ACCOUNT_ID`: Cloudflare account ID.
- `CLOUDFLARE_KV_NAMESPACE_ID`: Cloudflare Workers KV namespace ID used for redemption records.
- `CLOUDFLARE_API_TOKEN`: Cloudflare API token with Workers KV Storage Read and Write permissions for the namespace.
- `DISCORD_WEBHOOK_URL`: optional Discord webhook URL for run summaries.

Account configuration priority is `HIVE_ACCOUNTS`, then `HIVE_IDS`, then `HIVE_ID`.

Optional repository variables:

- `SW_SERVER`: one of `global`, `korea`, `japan`, `china`, `asia`, `europe`. Defaults to `china`.
- `INCLUDE_EXPIRED`: set to `true` to include expired coupons from the feed.
- `START_DELAY_MS`: randomized delay before querying coupons after the workflow starts. Defaults to `0-180000` (0-3 minutes). Set to `0` to disable.
- `REDEEM_DELAY_MS`: randomized delay between coupon attempts. Use a range like `4500-12000`; a single number is treated as the middle of a jittered range. Defaults to `4500-12000`.
- `ACTION_DELAY_MS`: randomized delay around page actions and the check-to-redeem step. Defaults to `800-2200`.
- `PAGE_TIMEOUT_MS`: Playwright page/action timeout. Defaults to `30000`.
- `PLAYWRIGHT_HEADED`: set to `true` only for local debugging with a visible browser.
- `KV_KEY_PREFIX`: Cloudflare KV key prefix. Defaults to `swcoupon:redeemed`.

The workflow runs once per day at 12:00 China Standard Time (04:00 UTC) and can also be started manually from the Actions tab.

Successful redemptions are saved in Cloudflare KV, not in the repository. Each account uses a key like `swcoupon:redeemed:<hiveIdHash>`, and the value stores redeemed coupon codes for that account/server. Discord notifications include each Hive ID.
