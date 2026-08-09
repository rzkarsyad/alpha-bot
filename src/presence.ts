// Presentation signals: profile, socials, boosts, and whether anyone paid
// DexScreener for placement.
//
// Read this for what it is. Paying $300 for a token profile does not make a
// token honest — a well-funded rug buys one without blinking. What it does is
// cost money and leave a receipt, which the cheapest throwaway launches skip.
// So these are useful as a *floor*, not as evidence: no profile, no socials and
// nothing paid means nobody invested anything in the token before launching it.
//
// Profile, socials and boosts arrive free on the pair response that the screener
// already fetches. Only the paid-order lookup costs an extra request, so it runs
// for the shortlist rather than for everything discovered.

import type { TokenPresence } from './types.ts';

const BASE = 'https://api.dexscreener.com';

type RawInfo = {
  imageUrl?: string;
  header?: string;
  websites?: unknown[];
  socials?: Array<{ type?: string; url?: string }>;
};

type RawOrder = { type?: string; status?: string; paymentTimestamp?: number };

/** Pull the presentation fields out of a pair's `info` object. */
export function readPresence(info: RawInfo | undefined, boostsActive: number | undefined): TokenPresence {
  const socials = (info?.socials ?? [])
    .map((s) => s.type)
    .filter((t): t is string => typeof t === 'string' && t.length > 0);

  return {
    // Artwork is the reliable marker: DexScreener only serves it once a profile
    // has been submitted and approved.
    hasProfile: Boolean(info?.imageUrl || info?.header),
    socials: [...new Set(socials)],
    websites: Array.isArray(info?.websites) ? info.websites.length : 0,
    boostsActive: typeof boostsActive === 'number' ? boostsActive : 0,
    paidOrders: [],
    paidAt: null,
    ordersChecked: false,
  };
}

/** Merge an orders lookup into an existing presence record. */
export function applyOrders(presence: TokenPresence, orders: RawOrder[]): TokenPresence {
  // Only approved orders count. A 'processing' payment can still be rejected.
  const approved = orders.filter((o) => o.status === 'approved');
  const timestamps = approved
    .map((o) => o.paymentTimestamp)
    .filter((t): t is number => typeof t === 'number');

  return {
    ...presence,
    paidOrders: [...new Set(approved.map((o) => o.type).filter((t): t is string => Boolean(t)))],
    paidAt: timestamps.length > 0 ? Math.min(...timestamps) : null,
    ordersChecked: true,
  };
}

/**
 * Look up what a token has paid DexScreener for.
 * Failures leave `ordersChecked` false so the caller can tell "not paid" apart
 * from "not checked" — the two must never collapse into the same answer.
 */
export async function fetchOrders(mint: string): Promise<RawOrder[] | null> {
  try {
    const res = await fetch(`${BASE}/orders/v1/solana/${mint}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { orders?: RawOrder[] } | RawOrder[];
    // The endpoint has returned both a bare array and an {orders} envelope.
    if (Array.isArray(body)) return body;
    return body.orders ?? [];
  } catch {
    return null;
  }
}

/** True when nobody has invested anything in how the token presents itself. */
export function isBare(presence: TokenPresence): boolean {
  return (
    !presence.hasProfile &&
    presence.socials.length === 0 &&
    presence.websites === 0 &&
    presence.boostsActive === 0 &&
    presence.paidOrders.length === 0
  );
}

/**
 * Short label for the table column, capped at 12 characters so a token with a
 * three-digit boost count cannot push into the next column.
 */
export function presenceBadge(presence: TokenPresence): string {
  const parts: string[] = [];
  if (presence.paidOrders.length > 0) parts.push('paid');
  else if (presence.hasProfile) parts.push('prof');
  if (presence.boostsActive > 0) {
    parts.push(`b${presence.boostsActive > 99 ? '99+' : presence.boostsActive}`);
  }
  if (presence.socials.length > 0) parts.push(`${Math.min(presence.socials.length, 9)}s`);
  // Widest possible result is "paid/b99+/9s" at 12 characters.
  return parts.length > 0 ? parts.join('/') : 'bare';
}
