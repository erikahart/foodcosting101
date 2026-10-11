# foodcosting101: logins setup

About 30 minutes. You'll do four things: create a Supabase project, run one script,
paste two values into `config.js`, and update your GitHub repository.

---

## 1. Create the Supabase project (5 min)

1. Go to **supabase.com**, sign up (free), and click **New project**.
2. Name it `foodcosting101`. Make a strong database password and **save it somewhere safe**
   (you won't need it day to day, but you can't see it again).
3. Pick the region closest to you (an East US region for Ohio). Click **Create**.
4. Wait a minute or two while it sets up.

## 2. Run the setup script (2 min)

1. In Supabase, click **SQL Editor** in the left menu, then **New query**.
2. Open `supabase/setup.sql` from this folder, copy **all** of it, and paste it in.
3. Click **Run**. You should see **Success. No rows returned.**

This creates the tables and the rules that keep each kitchen's data private.
It's safe to run again if you're unsure it worked.

## 3. Tell Supabase your website address (2 min)

1. **Authentication → URL Configuration.**
2. **Site URL:** `https://foodcosting101.netlify.app`
3. Under **Redirect URLs**, click **Add URL** and enter `https://foodcosting101.netlify.app/**`
4. Save.

This makes the links in confirmation and password-reset emails bring people back to your site.

## 4. Decide how sign-up emails work (important)

Supabase's built-in email only reaches people on your **Supabase team**, and only
2 emails an hour. Your cooks won't get their confirmation emails. Pick one:

**Option A: quick start for your own crew (5 min)**
1. **Authentication → Sign In / Providers → Email.**
2. Turn **off** "Confirm email". Save.

People can sign up and get in right away. The trade-off: nobody proves they own the
email address, so someone who knew your site and a cook's email could sign up as them
first. Fine for getting your post going; switch to Option B before you invite people
you don't know or sell this to other restaurants. Password-reset emails also won't
work for crew until Option B is set up (you can reset someone by removing and re-inviting them).

**Option B: proper email (20 to 30 min, do this before selling)**
1. Sign up with an email-sending service that offers SMTP and a free starter plan
   (for example Brevo, Resend, Postmark or SendLayer).
2. Follow their steps to verify the address or domain you'll send from.
   Owning a domain (like the one you'll buy for the product name) makes emails far less likely to land in spam.
3. In Supabase: **Authentication → Emails → SMTP Settings**, turn on **Enable custom SMTP**,
   and paste in the host, port, username and password the service gave you.
4. Keep "Confirm email" **on**.

## 5. Put your two Supabase values in `config.js` (2 min)

1. In Supabase: **Project Settings → API Keys** (or **Data API** on some screens).
2. Copy the **Project URL** (looks like `https://abcdefgh.supabase.co`).
3. Copy the **publishable key** (starts with `sb_publishable_`), or on older projects
   the **anon public** key (a long string starting with `eyJ`).
4. Open `config.js` in Notepad (Windows) or TextEdit (Mac) and replace the two
   `YOUR-...` values, keeping the quote marks. Save.

**Never** paste the `service_role` or `secret` key into `config.js`. Those keys skip
every privacy rule and must stay private.

## 6. Update your GitHub repository (5 min)

In your **foodcosting101** repository on GitHub:

1. **Delete the old data function:** open `netlify` → `functions` → `data.mjs`,
   click the trash-can icon (or ⋯ → Delete file), then **Commit changes**.
2. Go back to the repository's front page, click **Add file → Upload files**, and drag
   in everything from this folder: `index.html`, `config.js`, `netlify.toml`, `package.json`,
   `SETUP.md`, and the `netlify` and `supabase` folders. When GitHub asks, let it replace
   the old files. Click **Commit changes**.
3. Check the front page shows `config.js` and a `supabase` folder, and that
   `netlify/functions` has only `ai.mjs`.

Netlify will redeploy by itself within a minute or two.

## 7. Netlify settings (3 min)

In Netlify → **foodcosting101** → **Project configuration → Environment variables**:

| Add | Value |
| --- | --- |
| `SUPABASE_URL` | Same Project URL as in `config.js` |
| `SUPABASE_ANON_KEY` | Same publishable/anon key as in `config.js` |
| `ANTHROPIC_API_KEY` | Your Anthropic key (optional; turns on AI) |

You can **delete `EDIT_PIN`**; the app doesn't use it any more.
Then **Deploys → Trigger deploy → Deploy project.**

If you turn on AI, set a monthly spending limit in the Anthropic console so a busy month can't surprise you.

## 8. Try it

1. Open **foodcosting101.netlify.app**. You should see a **Welcome** sign-in screen.
2. **Create account** with your email and a password.
   (With Option B, click the link in the confirmation email, then sign in.)
3. Name your kitchen, for example `VFW Post 1234 Kitchen`. Choose **Start empty** for real
   use, or **Start with sample data** to explore first.
4. Go to **Brand & accounts → Team → Invite someone.** Enter a cook's email.
5. Tell the cook: go to the site, choose **Create account**, and use that exact email.
   They'll land straight in your kitchen.

## Who can do what

| | Owner | Manager | Member |
| --- | --- | --- | --- |
| Edit menu, supplies, invoices, settings | ✓ | ✓ | ✓ |
| Invite people, cancel invites | ✓ | ✓ | |
| Change roles, remove people | ✓ | | |

A kitchen always keeps at least one owner. Anyone can belong to several kitchens and switch
between them in the sidebar.

## If something's off

| You see | Fix |
| --- | --- |
| "Almost there… isn't connected to its database" | `config.js` still has `YOUR-…` in it, or the new file didn't upload. |
| "Couldn't load your kitchens" | The setup script didn't run. Repeat step 2. |
| Confirmation email never arrives | Step 4: choose Option A, or finish Option B. Check spam. |
| Email link opens a broken page | Step 3: Site URL and Redirect URL. |
| AI says "isn't switched on" | Add `ANTHROPIC_API_KEY` in Netlify and redeploy. |
| AI says "sign out and back in" | Add `SUPABASE_URL` and `SUPABASE_ANON_KEY` in Netlify and redeploy. |
| A cook signed up but sees "Set up your kitchen" | They used a different email than the invite, or (Option B) haven't clicked their confirmation link yet. Have them sign out and back in afterwards. |

## About your data

Each kitchen's menu, supplies and invoices are saved together in Supabase. Supabase's
free plan pauses projects after a stretch of no use, so once real people depend on it,
check Supabase's current plans and consider upgrading. Your data isn't deleted when paused,
but the site won't load until you un-pause it.
