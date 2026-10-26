/**
 * Non-safety configuration. The submission limits (5/day, 2/hour, 1 in flight, breaker at 3) are
 * deliberately NOT here: they live as literals in db/migrations/001_safety.sql, where no runtime
 * setting can reach them.
 */

/** Appointments are interpreted in Arizona time. Arizona does not observe DST, so the offset is fixed. */
export const TIMEZONE = 'America/Phoenix';
export const PHOENIX_UTC_OFFSET = '-07:00';

/**
 * Window around the requested appointment in which an existing inspection at the same property or for
 * the same customer counts as a potential duplicate. Must match the 14-day window in
 * safety.app_reserve_submission. Kept short so a 1-year warranty inspection at a house inspected last
 * year is not blocked.
 */
export const DUPLICATE_WINDOW_DAYS = 14;

/** Window used when reconciling an uncertain submission against Spectora. */
export const RECONCILE_WINDOW_MINUTES = 60;

export const SPECTORA_API_BASE = 'https://connect.spectora.com';
