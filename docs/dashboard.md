# Dashboard: greeting, search, preferences

## What already worked (unchanged)
- All tickets page: client-side search (name, email, message, summary, ID), priority/category/status filters and sort over the loaded tickets, with loading, empty, no-match and error states.
- Settings page: a read-only, measured system status (workspace, integrations, notifications, build info).

## What was decorative or missing
- The greeting was the fixed text "Good afternoon".
- The header search box (and the mobile search button) did nothing.
- Settings had no controls.

## Behaviour now
- **Greeting:** morning 05:00-11:59, afternoon 12:00-16:59, evening 17:00-04:59 in the chosen time zone, re-checked every minute. Before the browser clock is available it reads "Welcome back" so server and browser HTML agree.
- **Search:** the header box submits to `/tickets?q=...`; the tickets page fills its search box from `q`, keeps the address bar in step as you type, and combines the text with the existing filters and sort. It also matches the category (displayed or raw). No extra API calls: it filters the list already loaded (max 1000 tickets; a notice appears if truncated).
- **Preferences** (`GET/PUT /api/settings`, signed-in only, same-origin JSON, strict validation, stored in Firestore `app_settings/dashboard`, server-side so they follow the user across devices):
  - *Time zone* (Automatic = device, or any IANA zone): greeting, "Updated" labels, ticket dates, ticket detail, follow-up history, knowledge-base dates. Not applied to the overview chart's day buckets, which still use the browser's day.
  - *Refresh ticket lists* (never / 1 / 5 / 15 min): reloads overview, tickets and escalations while the tab is visible; a failed reload keeps the data shown.
  - *Default ticket order* (newest/oldest): the order All tickets opens in, unless changed on the page.
  - Defaults apply while loading or if loading fails. A failed save keeps what you typed and says so. Saved values never overwrite unsaved edits. Nothing secret is stored or returned.
- Email notification behaviour and the n8n workflows are not configurable here and were not changed.

## Verified
- Node tests (`tests/dashboard.test.ts`): greeting boundaries and time zones, search fields, empty/no-result/odd queries, search with filters and sort, settings validation, persistence round-trip with a fake Firestore, failed write leaves stored values alone, the API route's auth/origin/validation, the browser client's failure handling, and the form's state rules.
- Real browser (Chromium, local production build, **no Firebase credentials**): pages render at desktop and phone widths, the greeting matched the clock, header search navigates to `/tickets?q=...`, the Settings form renders, and a save that fails keeps the choices and shows the error with Save still enabled.
- **Not verified:** saving and reloading against a real Firestore (only the fake store and the 503 path were exercised), the ticket search UI over real tickets in a browser, the auto-refresh timer, and the time zone display across real tickets.

## Manual configuration
None required. Deploy the updated `firestore.rules` from the security phase (the new `app_settings` collection is server-only like the others). Dashboard preferences are created on first save.
