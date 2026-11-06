/**
 * What X API reads cost, for the estimates shown BEFORE a paid read.
 *
 * Source: https://docs.x.com/x-api/getting-started/pricing (pay-per-use),
 * read 2026-11-06 - the same figures as the owner's September 2026 notes:
 * an OWNED read (the owner's own bookmarks, likes, posts) is $0.001 per post,
 * any other post read $0.005. Billing is per resource returned, so asking for
 * more FIELDS or for media on the same request adds nothing (media is not a
 * billed read resource), and every resource is deduplicated within a 24-hour
 * UTC day, so a retry the same day is free. The page does not say whether a
 * quoted post pulled in through `includes` is billed, so an estimate treats
 * each one as a possible non-owned read - the upper end of the range.
 */
export const X_PRICES_CHECKED_ON = '2026-11-06';
export const X_PRICING_URL = 'https://docs.x.com/x-api/getting-started/pricing';

/** One post read from the owner's own bookmarks timeline. */
export const X_OWNED_READ_USD = 0.001;
/** One post read that is not the owner's (a by-id lookup, possibly a quoted post in `includes`). */
export const X_POST_READ_USD = 0.005;

/** A cost range in USD: `low` if quoted posts are free, `high` if each is a non-owned read. */
export interface CostRange {
  low: number;
  high: number;
}

/** What reading `posts` bookmarks costs, `quoted` of which quote another post. */
export function bookmarkReadCost(posts: number, quoted: number): CostRange {
  const low = posts * X_OWNED_READ_USD;
  return { low, high: low + quoted * X_POST_READ_USD };
}

/**
 * A range for a person to read: `about $0.01`, `$0.30-$0.81`, or `under $0.01`.
 * The top of the range rounds UP, so an estimate never understates (the
 * viewer's `XBORefresh.costText` applies the same rule).
 */
export function formatCostRange(cost: CostRange): string {
  if (cost.high < 0.005) return 'under $0.01';
  const low = `$${(Math.round(cost.low * 100) / 100).toFixed(2)}`;
  const high = `$${(Math.ceil(cost.high * 100 - 1e-9) / 100).toFixed(2)}`;
  return low === high ? `about ${low}` : `${low}-${high}`;
}
