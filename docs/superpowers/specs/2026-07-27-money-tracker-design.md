# Money Tracker — Design Spec (2026-07-27)

## What
Comfy, minimalistic PWA ("Money Tracker") for tracking household + personal spending in RM.
Installable from browser (Add to Home Screen), works on any device, accounts synced via cloud.

## Decisions (user-approved)
- **Backend:** Supabase free tier (auth, Postgres, Edge Functions). Static app hosted on Netlify.
- **Images are never stored.** Photos are sent to AI, structured data extracted, image discarded.
- **AI:** OpenAI API (gpt-4o-mini vision) via Supabase Edge Functions. Key lives as server secret, never in client.
- **Sharing:** Both modes, switchable. Personal ledger by default; optional household group joined
  by invite code. "Mine / Ours" view toggle. "Ours" = union of all household members' transactions.
- **Currency:** RM (MYR).

## Architecture
- `app/` — static PWA: index.html, app.css, app.js, config.js (Supabase URL + anon key),
  manifest.json, sw.js, icons. Vanilla JS, no build step. supabase-js from CDN (SW-cached).
- `supabase/schema.sql` — tables, RLS, triggers, helper functions.
- `supabase/functions/extract/index.ts` — receives base64 image(s), calls OpenAI vision with a
  strict JSON schema, returns array of transactions (receipt = 1, bank statement = many).
  Requires valid Supabase JWT (no anonymous abuse of the key).
- `supabase/functions/chat/index.ts` — chatbot. Server fetches the caller's visible transactions,
  compacts them into prompt context plus aggregates, asks OpenAI, returns answer.

## Data model
- `profiles` (id = auth.users.id, display_name, household_id nullable)
- `households` (id, name, invite_code unique)
- `transactions` (id, user_id, tx_date, merchant, total numeric, currency 'MYR', category,
  payment_method, source receipt|statement|manual, items jsonb, notes, created_at)
- `budgets` (id, user_id, category, monthly_limit) — personal budgets
- RLS: own rows always; household members can read each other's transactions via
  security-definer helper `my_household()`. Writes only to own rows.

## Screens (bottom nav)
1. **Home** — this-month total, month-vs-last delta, category donut, 6-month trend,
   top merchants, budget progress bars, monthly summary line.
2. **Breakdown** — category chips across top starting with **All**, tap to drill down.
   Transaction list with search; sort by: Recent (date), Date added, Most expensive,
   Least expensive. Tap a transaction to view/edit/delete (line items shown).
3. **Add** (center button) — camera / gallery multi-select / manual entry.
   AI extraction → review screen with editable fields → save. Duplicate warning on
   same merchant+total+date.
4. **Chat** — natural-language questions over your data ("last time at X?",
   "biggest spending?", recurring-spend spotting).
5. **Settings** — profile, household create/join/leave (invite code), share-history backfill
   is not needed (Ours = union by membership), budgets editor, CSV export, logout.

## Categories
Food & Drinks, Groceries, Transport, Shopping, Bills & Utilities, Health, Entertainment,
Travel, Education, Other. AI assigns; user can override.

## Theme
Warm cream background, soft ink text, sage-green accent, rounded cards, gentle shadows,
Nunito-style rounded type, auto dark mode. All figures in RM.

## Error handling
- Extraction fails / unreadable photo → pre-filled manual form.
- Offline → cached shell + last-loaded data view; adding needs connection.
- Edge functions reject unauthenticated calls.

## Out of scope
Image storage, bank integrations, push notifications, budgets for households.
