# Moving masterapp to Cloudflare R2 + DigitalOcean

## Live now — read this first (23 Oct 2026)

**masterapp is live at https://coral-app-7qthm.ondigitalocean.app** — use it
from any PC (the office PC included) in a browser. Nothing to install.

**Signing in.** The accounts were copied from the PC masterapp ran on until
23 Oct (Hasnain's PC, folder `masterapp-to-take-home-2026-10-22\masterapp`).
The first account is **`admin@local`**. Its password is **not in git, on
purpose** — it is the `adminPassword` line in `data\local.json` on that PC.
First thing on the live site: **Users** → make a personal admin account for
yourself and an account for each colleague, then **disable `admin@local`**.
Passwords never go into this repository.

**Where everything is**

| What | Where | Notes |
|---|---|---|
| The app | DigitalOcean App Platform, app **`coral-app`**, Bangalore (BLR1) | 1 container, $12/month. Deploys itself on every push to `main` of `Hasnu07/masterapp`. |
| The database | DigitalOcean Managed PostgreSQL **`masterapp-db`**, Bangalore | PostgreSQL 18, Basic 1 GB, $15.15/month, daily backups + a week of point-in-time restore. Only `coral-app` may connect (Network Access → trusted sources). To reach it from a PC (another move, a backup), add that PC's IP there for the job and remove it after. |
| Photos (and later PDFs) | Cloudflare R2 bucket **`purosangue-masterapp-apac`**, Asia-Pacific | Private — served only through the app, behind the sign-in. API token `masterapp` (Object Read & Write, this bucket only). |
| Secrets | coral-app's environment variables (encrypted), and `data\move.env` on Hasnain's PC | R2 keys, Chrono Key login, vault key, database address. **Never in git.** |
| The old local copy | `data\` on Hasnain's PC | Database + photos as of the move, 23 Oct 2026 — the backup. **Do not run it alongside the live site** (`start-masterapp.cmd`): it would keep a separate copy that drifts apart. |

**What was moved (23 Oct 2026), and how it was checked:** 1,671 watches,
4,529 photo records, 8,358 history entries, 1,662 Chrono Key records, 816
vault records and the accounts — every table byte-for-byte identical on
DigitalOcean (row fingerprints compared). Photo files: all 8,640 (originals +
thumbnails, 1.5 GB) uploaded to R2, and every one of the 4,320 photos with a
file checked there at its exact size. The Chrono Key / vault sync is ON in the
live app (`SYNC=on`), every 15 minutes until the switch-over; new photos it
copies go straight to R2. Move finished 23 Oct 2026, ~16:30 PKT.

**Logins for the services** (Cloudflare, DigitalOcean, GitHub) are Hasnain's
own accounts — with two-factor sign-in.

---

Decided 22 Oct 2026. Photos, PDFs and documents go to **Cloudflare R2**; the
app and its database to **DigitalOcean** (App Platform + Managed PostgreSQL).
About $25–30 a month at 50 GB of files (prices as known in Oct 2026 — check).

**Where: Bangalore (BLR1), and R2 in Asia-Pacific** — decided 23 Oct 2026,
because the people using it are in Pakistan and Dubai. Measured from the PC in
Pakistan: Singapore 105 ms, Bangalore 144 ms, Frankfurt 153 ms, London 159 ms;
Dubai is typically much closer to Bangalore (~30–50 ms) than to Europe.
DigitalOcean has no Gulf datacentre. App and database must be in the SAME
region — every page makes many queries.

As set up on 23 Oct 2026: bucket **`purosangue-masterapp-apac`** (APAC),
API token `masterapp` scoped to it; database **`masterapp-db`** (BLR1,
PostgreSQL 18, Basic 1 GB, $15.15/month, moved there from London); app
**`coral-app`** (BLR1). An R2 bucket re-created under a deleted bucket's
name lands back in the old one's location whatever hint is given — that is
why the bucket has a new name; an empty `purosangue-masterapp` (Western
Europe) is left over and can be deleted.

This PC stays the live copy until the move has been checked. Nothing here is
switched off until the new one is proven.

Who does what: **you** create the accounts and add payment (that has to be
you), and put the keys in one file on this PC. **Claude** puts the code on
GitHub, copies the photos and the database across, and checks every photo.

---

## 0 · Before you start (Claude)

- [ ] The picture import on this PC has finished and been checked.
- [ ] Today's work is committed and on GitHub's `main` branch
      (`Hasnu07/masterapp`) — App Platform deploys from there. Today `main`
      holds only the first commit; everything else is on a working branch.

## 1 · Cloudflare R2 — the photos (about 10 minutes)

1. Sign up at **dash.cloudflare.com** with a company email. Turn on two-factor
   sign-in (My Profile → Authentication).
2. Left menu → **R2 Object Storage** → add a payment method when asked. R2
   needs one even inside its free allowance (10 GB).
3. **Create bucket**
   - Name: `purosangue-masterapp-apac` — location hint **Asia-Pacific (APAC)**
   - Location: **Automatic** — or *Specify jurisdiction → European Union* if
     the company's data must stay in the EU. Decide now; it cannot be changed.
   - Storage class: Standard.
   - Leave **Public access OFF** and the **r2.dev URL disabled**. The photos
     are only ever served through masterapp, behind the sign-in, because
     papers and serials are in them.
4. Back on the R2 page → **Manage R2 API Tokens** (Account API tokens) →
   **Create API token**
   - Name: `masterapp`
   - Permissions: **Object Read & Write**
   - Specify bucket(s): **only `purosangue-masterapp-apac`**
   - TTL: Forever
   - Create. The next page shows the keys **once** — copy them now:
     **Access Key ID**, **Secret Access Key**, and the **S3 endpoint**
     (`https://<account id>.r2.cloudflarestorage.com`; for an EU bucket it has
     `.eu.` in it). The **Account ID** is also on the R2 overview page.

## 2 · DigitalOcean — the database (about 15 minutes, mostly waiting)

1. Sign up at **cloud.digitalocean.com**, turn on two-factor sign-in, add
   billing.
2. **Create → Databases**
   - Engine: **PostgreSQL**, the **newest version offered**
   - Datacenter: **Bangalore (BLR1)** — use the same one
     for the app in step 3
   - Plan: **Basic**, 1 GB RAM / 1 vCPU / 10 GB disk (about $15 a month; daily
     backups and a week of point-in-time restore are included)
   - Name: `masterapp-db` → Create. It takes a few minutes to come up.
3. When it is ready: **Connection details** → keep *database `defaultdb`*,
   *user `doadmin`* → choose **Connection string** → copy it (it has the
   password in it and ends `?sslmode=require`).
4. **Settings → Trusted sources** → add **this PC's IP address** (the panel
   offers your current one). Only for the move — it comes off afterwards.

## 3 · DigitalOcean — the app (about 15 minutes, after step 0)

1. **Create → Apps** → **GitHub** → let DigitalOcean see **only the
   `Hasnu07/masterapp` repository** → branch **`main`**, source directory
   `/`, **Autodeploy on** (a push to `main` deploys, as on Railway).
2. It detects Node.js. On the service, **Edit**:
   - Run command: `npm start`
   - HTTP port: **8080**
   - Health check: HTTP, path **`/healthz`**
3. Size: **Basic, 1 GB RAM**, **1 container** (photo processing needs the
   memory; one container keeps one copy of the Chrono Key sync running).
4. Region: the **same** as the database.
5. **Add resource → Database → Previously created DigitalOcean database →
   `masterapp-db`**. This also lets the app through the database's trusted
   sources.
6. **Environment variables** — app level; tick **Encrypt** on every secret:

   | Name | Value |
   |---|---|
   | `NODE_ENV` | `production` (sign-in cookies only over https) |
   | `PORT` | `8080` |
   | `DATABASE_URL` | `${masterapp-db.DATABASE_URL}` (DigitalOcean fills it in) |
   | `DATABASE_CA_CERT` | `${masterapp-db.CA_CERT}` — DigitalOcean's certificate for the database, so the app can verify it |
   | `R2_ACCOUNT_ID` | from step 1.4 |
   | `R2_ACCESS_KEY_ID` | from step 1.4 — encrypt |
   | `R2_SECRET_ACCESS_KEY` | from step 1.4 — encrypt |
   | `R2_BUCKET` | `purosangue-masterapp-apac` |
   | `R2_ENDPOINT` | only for an EU bucket: the `.eu.` endpoint from step 1.4 |
   | `CHRONOKEY_USERNAME` | the same as in this PC's `.env` — encrypt |
   | `CHRONOKEY_PASSWORD` | the same as in this PC's `.env` — encrypt |
   | `VAULT_TOKEN` | the same as in this PC's `.env` — encrypt |
   | `SYNC` | **`off`** — until the move is checked; Claude says when |

   Do **not** set `ADMIN_EMAIL` / `ADMIN_PASSWORD`: the accounts come across
   with the database.
7. Create. When the first deploy is green, open the app's address
   (`https://…ondigitalocean.app`). You should see the sign-in page. It is
   empty until the move.

## 4 · What to send Claude

**No keys in the chat.** Put them in one file on this PC —
`data\move.env` (the `data` folder is never committed) — like this:

```
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=purosangue-masterapp-apac
R2_ENDPOINT=
TARGET_DATABASE_URL=
APP_URL=
```

`R2_ENDPOINT` only for an EU bucket. `TARGET_DATABASE_URL` is the connection
string from step 2.3; `APP_URL` the address from step 3.7. Then say
**"move.env is ready"**.

Why not in `.env`: with R2 keys in this PC's `.env`, the local masterapp
would start keeping photos in R2 instead of `data\`, before they are there.

## 5 · The move (Claude, about an hour)

1. Stop the sync on this PC; one last read of Chrono Key's list and new pages.
2. Upload every photo and thumbnail in `data\photos` to the bucket under the
   same names; check each one arrived whole (size).
3. Copy the database into DigitalOcean (this PC runs Postgres 18 — if the
   offered version is older, the copy is made to suit it); check the row
   counts match, table by table.
4. Check the new app end to end: sign in, open watches, and confirm every
   photo the database names opens from R2.
5. You set `SYNC` to **`on`** on DigitalOcean. This PC's copy becomes the
   spare: start it with `SYNC=off`, or not at all.
6. Take this PC's IP off the database's trusted sources.
7. Add a weekly database copy into the bucket — a second copy besides
   DigitalOcean's daily backups.

## 6 · Later, recommended

- **Your own address**, e.g. `erp.<company>.com`, through Cloudflare DNS.
- **Cloudflare Access** in front (free for small teams): only the email
  addresses you list ever reach the sign-in page. Worth it — papers and
  serials are in those photos.
