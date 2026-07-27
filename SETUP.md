# Money Tracker — Setup (one time, ~10 minutes)

Three things to set up: **Supabase** (database + accounts + AI functions), an **OpenAI key**, and **Netlify** (hosting). Everything except OpenAI usage is free.

---

## 1. Supabase (database + accounts)

1. Go to https://supabase.com → sign up (free) → **New project**.
   - Name: `money-tracker` · pick a strong database password (you won't need it daily) · region: Singapore.
2. Wait ~2 min for the project to spin up.
3. **Run the schema:** left sidebar → **SQL Editor** → **New query** → paste the whole contents of `supabase/schema.sql` → **Run**. Should say "Success".
4. **Turn off email confirmation** — REQUIRED, not optional: the app uses usernames, not real
   emails (it quietly maps `gen` to `gen@moneytracker.local`), so confirmation mails can never arrive.
   - **Authentication → Sign In / Up → Email** → toggle **Confirm email** OFF → Save.
5. **Get your keys:** **Settings → API**. Copy:
   - Project URL (like `https://abcdefgh.supabase.co`)
   - `anon` `public` key
6. Paste both into `app/config.js`.

## 2. Edge Functions (the AI part)

1. In the Supabase dashboard: **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Create a function named exactly `extract` → replace the sample code with the contents of `supabase/functions/extract/index.ts` → **Deploy**.
3. Same again for a function named `chat` → paste `supabase/functions/chat/index.ts` → **Deploy**.
4. **Add your OpenAI key:** **Edge Functions → Secrets** (or Settings → Edge Functions) → add secret:
   - Name: `OPENAI_API_KEY`
   - Value: your key from https://platform.openai.com/api-keys (create an account, add a small amount of credit — RM 25 lasts months at personal use).

## 3. Netlify (hosting)

1. Go to https://app.netlify.com/drop
2. Drag the **`app` folder** onto the page. Done — you get a URL like `https://something.netlify.app`.
   - (Optional: sign up first so you can keep the site and rename it, e.g. `money-tracker-gen.netlify.app`.)

## 4. On your phones

1. Open the Netlify URL in the phone browser.
2. **Android/Chrome:** menu ⋮ → **Add to Home screen**. **iPhone/Safari:** Share → **Add to Home Screen**.
3. Create your account (username, password — anything you like). Second person does the same on their phone.
4. One of you: **Settings → Household → Create**, share the 6-letter code; the other joins with it. Now the **Mine / Ours** toggle appears.

---

### Later changes
- Edited `app/` files? Drag the folder onto Netlify Drop again (or connect the git repo for auto-deploys).
- The database and functions never need redeploying unless you change files under `supabase/`.

### Costs (RM)
- Supabase: RM 0 (free tier — plenty for a family).
- Netlify: RM 0.
- OpenAI: pay-per-use. A receipt scan ≈ RM 0.01–0.03; a chat question ≈ RM 0.01. A busy month ≈ RM 2–5.
