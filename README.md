# Talabia — Android app

GitHub builds the app automatically each time files are uploaded.
Get it from the **Actions** tab → latest run → **Artifacts → Talabia-APK**.

- `Talabia.apk` — install on phones to test
- `Talabia-PlayStore.aab` — upload to Google Play (only when the 4 signing secrets are set)

The app itself is `app/src/main/assets/index.html`.

## Supabase scripts (run once each, in SQL Editor)
- `server/schema.sql` — accounts and shops (already done)
- `server/delete-account.sql` — lets sellers delete their account
- `server/team.sql` — Pro team access
- `server/smart-fill.ts` — AI function, for later
