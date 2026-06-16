# Putting Happy Paint Online — The Simple Guide

This is the no-experience-needed version. Follow it top to bottom and you'll have
the website live on the internet. Each step says **what to click** and **what you
should see**. If something looks different, check the **"If it goes wrong"** box at
the end.

There are two services:

1. **DigitalOcean** — hosts the **website** (the drawing app people open in a browser).
2. **Supabase** — the **accounts + cloud save** ("sign in", "sync across devices").

**You can launch with just DigitalOcean.** Supabase is optional. If you skip it,
the app still fully works — drawings just save on each person's own device instead
of syncing. So if you want to go live fast, do **Part 1** and stop. Add **Part 2**
later whenever you want accounts.

You will need:
- The project code in a **GitHub** repository (free — github.com).
- A **DigitalOcean** account (free to make; hosting a small static site is cheap, often a few dollars/month, sometimes free tier).
- (Optional) A **Supabase** account (free tier is fine to start).

---

## Part 1 — Put the website online with DigitalOcean

We'll use DigitalOcean **App Platform**, which builds and hosts the site for you.
You don't touch a server.

### Step 1.1 — Get the code onto GitHub
If your code is already on GitHub, skip this.

1. Go to https://github.com and sign in (or make a free account).
2. Click the **+** in the top-right → **New repository**.
3. Name it `happypaint`, leave it **Private** (or Public, your choice), click **Create repository**.
4. Follow GitHub's "push an existing repository" instructions, OR use the GitHub Desktop app to publish the folder. The goal: your `happypaint` code shows up on github.com.

✅ **You should see:** your files (like `index.html`, `package.json`, `src/`) listed on the GitHub repo page.

### Step 1.2 — Create the App on DigitalOcean
1. Go to https://cloud.digitalocean.com and sign in.
2. In the left menu click **App Platform** → big blue **Create App** button.
3. Choose **GitHub** as the source. Authorize DigitalOcean to see your GitHub (a popup asks permission — click **Authorize**).
4. Pick your **`happypaint`** repository and the **`main`** branch.
5. Leave **"Autodeploy"** checked (this re-publishes the site automatically every time you push new code to GitHub).
6. Click **Next**.

### Step 1.3 — Tell it this is a static website
DigitalOcean tries to guess the settings. Make sure they match this:

- **Resource type:** it should detect a **Static Site**. If it shows "Web Service" instead, change it to **Static Site** (there's a dropdown / "Edit" link on the component).
- **Build Command:** `npm ci && npm run build`
- **Output Directory:** `dist`

> 💡 Good news: this repo already includes a file at `.do/app.yaml` that contains
> these exact settings. If DigitalOcean asks whether to use the app spec from the
> repo, say **yes** and it fills most of this in for you.

Click **Next** through the remaining screens.

### Step 1.4 — Pick the plan and launch
1. Choose the **Starter / Basic** static site plan (the cheapest — static sites are inexpensive).
2. Give the app a name (e.g. `happypaint`).
3. Click **Create Resources**.
4. Wait ~2–5 minutes while it builds. You'll see a build log scroll by.

✅ **You should see:** "Deployed successfully" and a link like
`https://happypaint-xxxxx.ondigitalocean.app`. Click it — **your drawing app is live!** 🎉

### Step 1.5 — (Optional) Use your own domain name
If you bought a domain (like `happypaint.app`):
1. In your app, go to **Settings → Domains → Add Domain**.
2. Type your domain and follow the on-screen DNS instructions (you add one record at your domain registrar). DigitalOcean handles the HTTPS lock icon automatically.

**That's it for the basic launch.** Stop here if you don't need accounts yet.

---

## Part 2 — Turn on accounts + cloud save with Supabase (optional)

Supabase is a separate free service that stores accounts and synced drawings.
DigitalOcean and Supabase don't "know" about each other — you connect them by
copying **two values** from Supabase into DigitalOcean. That's the whole trick.

### Step 2.1 — Make a Supabase project
1. Go to https://supabase.com and sign in (free account).
2. Click **New project**. Pick any name, set a strong database password (save it somewhere), choose the region closest to your users, click **Create**.
3. Wait ~2 minutes for it to finish setting up.

### Step 2.2 — Load the database structure
The app needs its tables/rules created. The files are in this repo under `backend/supabase/`.
1. In Supabase, click **SQL Editor** in the left menu → **New query**.
2. Open the repo file `backend/supabase/schema.sql`, copy **all** of it, paste into the editor, click **Run**. You should see "Success."
3. New query again. Open `backend/supabase/storage.sql`, copy all, paste, **Run**. (This creates the image storage buckets.)

✅ **You should see:** "Success. No rows returned" (that's normal for setup scripts).

### Step 2.3 — Copy your two connection values
1. In Supabase, click **Project Settings** (gear icon) → **API**.
2. Find and copy these two (keep them in a note for the next step):
   - **Project URL** — looks like `https://abcdefgh.supabase.co`
   - **anon public** key — a long string labeled `anon` / `public`.

> 🔒 The **anon public** key is safe to put in a website — it's meant to be public.
> **Never** use the **`service_role`** key in the website. Leave that one alone.

### Step 2.4 — Tell DigitalOcean about Supabase
1. Back in DigitalOcean → your app → **Settings → App-Level Environment Variables**
   (or edit the **web** component's environment variables).
2. Add **two** variables (click "Edit", then add each):

   | Key | Value | Scope |
   |-----|-------|-------|
   | `VITE_SUPABASE_URL` | *(paste the Project URL)* | **Build Time** |
   | `VITE_SUPABASE_ANON_KEY` | *(paste the anon public key)* | **Build Time** |

   ⚠️ The scope **must be "Build Time"** (not Run Time). The website bakes these in
   when it builds.
3. Click **Save**. DigitalOcean will rebuild and redeploy the app (~3 min).

✅ **You should see:** after the rebuild, opening the site and going to the
**Account** panel now offers real sign-in (email magic link / Apple / Google)
instead of "sync not configured."

### Step 2.5 — Let sign-in links come back to your site
When someone signs in by email link or with Google/Apple, Supabase needs to know
which website to send them back to.
1. In Supabase → **Authentication → URL Configuration**.
2. In **Site URL** and **Redirect URLs**, add your live site address
   (e.g. `https://happypaint.app` and the `…ondigitalocean.app` address). For local
   testing you can also add `http://localhost:5173`.
3. Save.

### Step 2.6 — (Optional) Turn on Google / Apple sign-in
Email magic-link works with no extra setup. For the Google/Apple buttons:
1. Supabase → **Authentication → Providers** → enable **Google** and/or **Apple**.
2. Each asks for a "client ID" and "secret" you create in Google/Apple's developer
   consoles. Follow Supabase's linked instructions for each. (You can skip this and
   rely on email magic-link to start.)

### Step 2.7 — (Optional) Auto-delete data for "delete my account"
The app has a "Delete my data & account" button. It instantly wipes the person's
device and files a deletion request. To also erase their cloud data automatically:
1. Install the Supabase CLI (one-time): https://supabase.com/docs/guides/cli
2. From the repo folder run:
   ```
   supabase functions deploy purge-account
   supabase secrets set SERVICE_ROLE_KEY=<your service_role key from Settings → API>
   ```
3. Schedule it to run daily (instructions in `backend/supabase/functions/README.md`).

This is optional for launch — the in-app deletion already removes the person's data
from their device immediately either way.

---

## Updating the site later
Because **Autodeploy** is on: just push your code changes to the `main` branch on
GitHub. DigitalOcean rebuilds and republishes automatically in a few minutes. You
don't click anything.

---

## A quick note about the phone apps
The **iPhone/Android apps are NOT hosted on DigitalOcean.** They're published to the
Apple App Store and Google Play through Expo. DigitalOcean only hosts the website.
The phone apps use the same Supabase project — you put the same two values into the
mobile build as `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY`
(see `.env.example`). That's a separate release process for later.

---

## If it goes wrong (troubleshooting)

**The build failed on DigitalOcean.**
Open the **build logs** (DigitalOcean shows them). Most common causes:
- Build command isn't `npm ci && npm run build`, or output directory isn't `dist`. Fix in the component settings.
- A code error you pushed — the log will name the file. Fixing it and pushing again triggers a fresh build.

**The site loads but refreshing a page like `/studio` shows "Not Found".**
The static site needs a "catch-all" so all paths serve `index.html`. This repo's
`.do/app.yaml` already sets `catchall_document: index.html`. If you set the app up
by hand, set the **Catchall Document** to `index.html` in the static site settings.

**The Account panel still says "sync not configured" after adding Supabase.**
- The two env vars must be spelled exactly `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, scope **Build Time**, and you must let it **rebuild** after adding them.
- Confirm you pasted the **Project URL** and the **anon public** key (not the database password, not service_role).

**Sign-in email arrives but the link errors / loops.**
Add your exact site address to Supabase → **Authentication → URL Configuration**
(both Site URL and Redirect URLs). The address must match what's in the browser bar,
including `https://`.

**"Is it safe that the anon key is in the website?"**
Yes — it's designed to be public. The real protection is the database's Row Level
Security rules (created by `schema.sql`), which only let people touch their own data.
Just never put the **service_role** key in the website.

---

## One-paragraph summary
Push the code to GitHub → DigitalOcean App Platform builds it as a **Static Site**
(`npm ci && npm run build`, output `dist`, catch-all `index.html`) and gives you a
live URL. That alone is a working app. To add accounts, make a **Supabase** project,
run `schema.sql` + `storage.sql`, then paste the **Project URL** and **anon public**
key into DigitalOcean as **Build Time** env vars `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY`, and add your site to Supabase's redirect URLs. Done.
