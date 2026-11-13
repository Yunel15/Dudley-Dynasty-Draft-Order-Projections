# Turning on website sign-in

Sign-in is built in but hidden until you add two values near the top of the script in `index.html`:

```js
const AUTH_URL = '', AUTH_KEY = '';   // Supabase project URL and anon (public) key
```

## One-time setup (about 10 minutes)

1. Create a free project at supabase.com.
2. Project Settings > API: copy the **Project URL** and the **anon public** key into `AUTH_URL` / `AUTH_KEY`. (The anon key is meant to be public; the table rules below keep each person's data private.)
3. Authentication > Providers: make sure **Email** is on. Leave "Confirm email" on (recommended).
4. Authentication > URL Configuration: set **Site URL** to `https://dudleydynasty.com` (confirmation and password-reset links return there).
5. SQL Editor: run this once:

```sql
create table public.user_prefs (
  user_id uuid primary key references auth.users(id) on delete cascade,
  league_id text,
  team integer,
  theme text check (theme in ('light','dark')),
  updated_at timestamptz not null default now()
);
alter table public.user_prefs enable row level security;
create policy "read own prefs"   on public.user_prefs for select using (auth.uid() = user_id);
create policy "insert own prefs" on public.user_prefs for insert with check (auth.uid() = user_id);
create policy "update own prefs" on public.user_prefs for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

## How it behaves
- Header "Sign in" button on desktop; **More > Account** on phones.
- Pinned team and theme sync across devices. On sign-in, saved account settings win; a brand-new account takes this device's settings.
- Signed-out visitors see the site exactly as before.
