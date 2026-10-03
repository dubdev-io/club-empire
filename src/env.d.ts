/// <reference types="vite/client" />

/**
 * Short commit SHA, substituted by Vite's `define` at build time.
 *
 * A compile-time constant rather than a runtime fetch: the overlay has to be
 * able to say which build produced a frame-rate number, and the answer must
 * survive being read off a phone with no network and pasted into a ticket.
 * Falls back to `dev` on the dev server and to `unknown` when the build runs
 * outside a git checkout. See `vite.config.ts`.
 */
declare const __CLUB_BUILD__: string;
