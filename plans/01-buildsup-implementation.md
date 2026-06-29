# BuildsUp — Implementation Plan

Construction marketplace for materials, chemicals, services, and labour.
Two platforms: `apps/web` (Next.js 15, App Router) and `apps/mobile` (Expo SDK 53, Expo Router v3).
Backend: Supabase (PostgreSQL + Auth + Storage + Realtime).

---

## Phase 0: Documentation Discovery (Complete)

### Allowed APIs

| Area | Key APIs | Source |
|---|---|---|
| Supabase Auth (web) | `createServerClient` from `@supabase/ssr`; `getUser()` (NOT `getSession()`); `exchangeCodeForSession(code)` | @supabase/ssr docs |
| Supabase Auth (mobile) | `createClient` with `{ auth: { storage: AsyncStorage, detectSessionInUrl: false } }` | supabase-js docs |
| Next.js middleware | `updateSession` pattern; `getAll/setAll` cookie interface (NOT deprecated `get/set/remove`) | @supabase/ssr docs |
| Next.js metadata | `generateMetadata({ params }: { params: Promise<{id:string}> })` — params is a Promise in Next.js 15 | Next.js 15 docs |
| Expo Router auth guard | `useSegments()` + `useRouter()` + `router.replace()` in `app/_layout.tsx` | Expo Router docs |
| Expo push | `Notifications.getExpoPushTokenAsync({ projectId })` + `requestPermissionsAsync()` | expo-notifications docs |
| Supabase DB | `gen_random_uuid()` (no extension needed); `websearch_to_tsquery` for FTS | PostgreSQL / Supabase docs |
| Supabase Realtime | `.channel().on('postgres_changes', { event, schema, table, filter }, cb).subscribe()` | supabase-js v2 docs |
| Storage upload (web) | `supabase.storage.from('listing-images').upload(path, file, { contentType })` | supabase-js docs |
| Storage upload (mobile) | `FileSystem.readAsStringAsync(uri, { encoding: Base64 })` → `decode(base64)` → `.upload(path, arrayBuffer)` | Expo + supabase-js docs |

### Anti-Patterns to Avoid

- Never use `supabase.auth.getSession()` in middleware or server components — use `getUser()` (validates JWT server-side)
- Never use the deprecated `get/set/remove` cookie interface in `@supabase/ssr` — use `getAll/setAll`
- Never return a fresh `NextResponse.next()` from middleware — always return the `supabaseResponse` object
- Never set `detectSessionInUrl: true` in React Native Supabase client (no `window.location` in RN)
- Don't use `expo-secure-store` for Supabase sessions (2048-byte iOS limit) — use `AsyncStorage` for sessions
- Don't `await` `supabase.storage.getPublicUrl()` — it is synchronous
- `redirect()` in Server Actions must not be inside a `try/catch` block

---

## Phase 1: Database & Infrastructure

**Goal:** All Supabase tables, RLS policies, storage buckets, and FTS in place before writing any app code.

### 1.1 Supabase Project Setup

1. Create project at https://supabase.com/dashboard
2. Copy Project URL and anon key into:
   - `apps/web/.env.local` — `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `apps/mobile/.env` — `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`
3. In Supabase dashboard → Authentication → URL Configuration:
   - Add `http://localhost:3000/auth/callback` (web dev)
   - Add `myapp://auth/callback` (mobile — replace `myapp` with your app scheme from `app.json`)

### 1.2 SQL Migrations

Create a `supabase/migrations/` directory and run each in the Supabase SQL editor (or via `supabase db push` if using the CLI).

**`001_enums.sql`**
```sql
CREATE TYPE public.listing_category AS ENUM (
  'materials', 'chemicals', 'services', 'labour'
);

CREATE TYPE public.listing_type AS ENUM (
  'availability', 'requirement'
);
```

**`002_profiles.sql`**
```sql
CREATE TABLE public.profiles (
  id          UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  full_name   TEXT,
  avatar_url  TEXT,
  phone       TEXT,
  push_token  TEXT,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Profiles are publicly viewable"
  ON public.profiles FOR SELECT USING (true);

CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE TO authenticated
  USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

-- Auto-create profile on sign-up
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, avatar_url)
  VALUES (NEW.id, NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'avatar_url');
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
```

**`003_listings.sql`**
```sql
CREATE TABLE public.listings (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_id    UUID REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
  title       TEXT NOT NULL,
  description TEXT,
  category    public.listing_category NOT NULL,
  type        public.listing_type NOT NULL,
  price       NUMERIC(12, 2),
  currency    TEXT DEFAULT 'INR',
  location    TEXT,
  image_urls  TEXT[] DEFAULT '{}',
  is_active   BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.listings ENABLE ROW LEVEL SECURITY;

-- RLS policies
CREATE POLICY "Listings are viewable by everyone"
  ON public.listings FOR SELECT USING (true);

CREATE POLICY "Users can insert their own listings"
  ON public.listings FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = owner_id);

CREATE POLICY "Users can update their own listings"
  ON public.listings FOR UPDATE TO authenticated
  USING (auth.uid() = owner_id) WITH CHECK (auth.uid() = owner_id);

CREATE POLICY "Users can delete their own listings"
  ON public.listings FOR DELETE TO authenticated
  USING (auth.uid() = owner_id);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

CREATE TRIGGER listings_updated_at
  BEFORE UPDATE ON public.listings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Full-text search (title A, description B, location C)
ALTER TABLE public.listings ADD COLUMN fts TSVECTOR;

CREATE OR REPLACE FUNCTION public.listings_fts_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.fts :=
    setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.description, '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(NEW.location, '')), 'C');
  RETURN NEW;
END;
$$;

CREATE TRIGGER listings_fts_trigger
  BEFORE INSERT OR UPDATE ON public.listings
  FOR EACH ROW EXECUTE FUNCTION public.listings_fts_update();

CREATE INDEX listings_fts_idx ON public.listings USING GIN (fts);
CREATE INDEX listings_category_idx ON public.listings (category);
CREATE INDEX listings_type_idx ON public.listings (type);

-- Enable Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.listings;
```

**`004_enquiries.sql`**
```sql
CREATE TABLE public.enquiries (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  listing_id  UUID REFERENCES public.listings(id) ON DELETE CASCADE NOT NULL,
  sender_id   UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  receiver_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  message     TEXT NOT NULL,
  is_read     BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.enquiries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own enquiries"
  ON public.enquiries FOR SELECT TO authenticated
  USING (auth.uid() = sender_id OR auth.uid() = receiver_id);

CREATE POLICY "Users can send enquiries"
  ON public.enquiries FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = sender_id);

CREATE POLICY "Receiver can mark as read"
  ON public.enquiries FOR UPDATE TO authenticated
  USING (auth.uid() = receiver_id);

ALTER PUBLICATION supabase_realtime ADD TABLE public.enquiries;
```

**`005_storage.sql`**
```sql
INSERT INTO storage.buckets (id, name, public)
VALUES ('listing-images', 'listing-images', true);

CREATE POLICY "Public can read listing images"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'listing-images');

CREATE POLICY "Users can upload to their own folder"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'listing-images'
    AND (storage.foldername(name))[1] = auth.uid()::TEXT
  );

CREATE POLICY "Users can delete their own images"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'listing-images'
    AND (storage.foldername(name))[1] = auth.uid()::TEXT
  );
```

### 1.3 Update Shared Types

Update `packages/shared/src/types.ts` to match the DB schema exactly (add `imageUrls`, `isActive`, `currency`, `ownerId` vs `userId`).

### 1.4 Verification Checklist
- [ ] `profiles` table auto-populates when a test user signs up
- [ ] `SELECT * FROM listings` returns empty set with no RLS errors
- [ ] A listing inserted with an authenticated role is returned by SELECT
- [ ] A listing inserted with `owner_id` ≠ `auth.uid()` is rejected (RLS)
- [ ] FTS: `SELECT * FROM listings WHERE fts @@ websearch_to_tsquery('english', 'test')` runs without error
- [ ] Storage bucket `listing-images` exists and is public
- [ ] Realtime publication includes both tables

---

## Phase 2: Auth — Web (Next.js)

**Goal:** Email/password sign-up, sign-in, sign-out, email confirmation callback, and route protection.

### 2.1 App Router File Structure

```
apps/web/
├── middleware.ts                       ← Session refresh + route guard
├── lib/
│   └── supabase/
│       ├── client.ts                   ← (exists) browser client
│       ├── server.ts                   ← (exists) server client
│       └── middleware.ts               ← NEW: updateSession helper
└── app/
    ├── (auth)/
    │   ├── layout.tsx                  ← Centered card layout, no nav
    │   ├── login/
    │   │   ├── page.tsx
    │   │   └── actions.ts              ← login() + signup() server actions
    │   └── register/
    │       └── page.tsx
    └── auth/
        └── callback/
            └── route.ts                ← exchangeCodeForSession handler
```

### 2.2 Middleware

**`apps/web/middleware.ts`**
```typescript
import { type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'

export async function middleware(request: NextRequest) {
  return await updateSession(request)
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
```

**`apps/web/lib/supabase/middleware.ts`** — copy the `updateSession` pattern exactly. Protected prefixes: `/dashboard`, `/listings/new`, `/profile`. Pattern `/listings/[id]/edit` also protected. Public: `/`, `/browse`, `/listings/[id]`, `/login`, `/register`, `/auth`, `/api/og`.

Critical: use `getUser()` not `getSession()`. Return `supabaseResponse` not a new `NextResponse.next()`.

### 2.3 Auth Callback Route

**`apps/web/app/auth/callback/route.ts`**
```typescript
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const next = searchParams.get('next') ?? '/dashboard'

  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) return NextResponse.redirect(`${origin}${next}`)
  }

  return NextResponse.redirect(`${origin}/login?error=auth-callback-failed`)
}
```

### 2.4 Server Actions

**`apps/web/app/(auth)/login/actions.ts`** — implement `login(formData)` and `signup(formData)` using `supabase.auth.signInWithPassword` and `supabase.auth.signUp`. On error: `redirect('/login?error=...')`. On success: `revalidatePath('/', 'layout')` then `redirect('/dashboard')`.

**Sign-out action** in `apps/web/app/(dashboard)/actions.ts`: call `supabase.auth.signOut()` then `redirect('/login')`.

### 2.5 Verification Checklist
- [ ] `pnpm --filter web dev` starts without errors
- [ ] `/login` renders without runtime errors
- [ ] Sign up → confirmation email → `/auth/callback?code=...` → redirects to `/dashboard`
- [ ] Sign in with valid credentials → `/dashboard`
- [ ] Sign in with wrong password → error message shown
- [ ] Visiting `/dashboard` while logged out → redirected to `/login`
- [ ] `supabase.auth.getUser()` returns user in a Server Component after sign-in

---

## Phase 3: Auth — Mobile (Expo)

**Goal:** Session persistence, auth guard, sign-in/sign-up screens, deep link email confirmation.

### 3.1 Install Dependencies

```bash
cd apps/mobile
npx expo install @react-native-async-storage/async-storage react-native-url-polyfill expo-linking
```

### 3.2 Update Supabase Client

Replace `apps/mobile/lib/supabase.ts` with:
```typescript
import 'react-native-url-polyfill/auto'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  process.env.EXPO_PUBLIC_SUPABASE_URL!,
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
  {
    auth: {
      storage: AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,   // required for React Native
    },
  }
)
```

### 3.3 App Router File Structure

```
apps/mobile/app/
├── _layout.tsx          ← Root layout: auth listener + useProtectedRoute
├── (auth)/
│   ├── _layout.tsx      ← Stack, no header
│   ├── sign-in.tsx
│   └── sign-up.tsx
└── (tabs)/
    ├── _layout.tsx      ← Tab bar: Home, Browse, Post, Messages, Profile
    ├── index.tsx        ← Home
    ├── browse/
    │   ├── _layout.tsx  ← Stack inside tab
    │   ├── index.tsx    ← Listing grid
    │   └── [id].tsx     ← Listing detail
    ├── post.tsx         ← Create listing
    ├── messages/
    │   ├── _layout.tsx
    │   ├── index.tsx    ← Inbox
    │   └── [id].tsx     ← Thread
    └── profile.tsx
```

### 3.4 Root Layout — Auth Guard

**`apps/mobile/app/_layout.tsx`** — implement `useProtectedRoute` using `useSegments` + `useRouter`. Key logic:
- `getSession()` on mount to seed state (acceptable here — not a security boundary)
- `onAuthStateChange` listener → `setSession`
- `AppState` listener → `startAutoRefresh` / `stopAutoRefresh` on foreground/background
- Guard: if `!session && !inAuthGroup` → `router.replace('/(auth)/sign-in')`
- Guard: if `session && inAuthGroup` → `router.replace('/(tabs)')`
- `initialized` flag prevents flash-redirect before storage read completes

### 3.5 Deep Link Configuration

**`apps/mobile/app.json`** — add scheme:
```json
{ "expo": { "scheme": "buildsup" } }
```

In `_layout.tsx`, add `Linking.getInitialURL()` + `Linking.addEventListener('url', ...)`. On URL with `?code=...`: call `supabase.auth.exchangeCodeForSession(code)`.

In Supabase dashboard → Auth → URL Configuration: add `buildsup://auth/callback`.

In sign-up action: `options: { emailRedirectTo: __DEV__ ? Linking.createURL('/auth/callback') : 'buildsup://auth/callback' }`.

### 3.6 Verification Checklist
- [ ] Cold-start with no stored session → lands on sign-in screen
- [ ] Sign up → confirmation email → tapping link opens app and navigates to `(tabs)`
- [ ] Sign in → navigates to `(tabs)`
- [ ] Background app for 30s → re-open → session still valid (AppState refresh)
- [ ] Sign out → navigates to sign-in

---

## Phase 4: Listings — Browse & Detail

**Goal:** Browse listings with category/type filters and full-text search. Listing detail page.

### 4.1 Web — Browse Page

**Route:** `apps/web/app/(marketplace)/browse/page.tsx`

This is a Server Component. Accept `searchParams` (category, type, q) from the URL. Build a Supabase query:

```typescript
let query = supabase.from('listings').select('*, profiles(full_name, avatar_url)').eq('is_active', true)

if (category) query = query.eq('category', category)
if (type) query = query.eq('type', type)
if (q) query = query.textSearch('fts', q, { config: 'english', type: 'websearch' })

const { data: listings } = await query.order('created_at', { ascending: false }).limit(20)
```

Render a filter bar (Client Component using `useRouter` + `useSearchParams`) and a listings grid.

**`apps/web/next.config.ts`** — add `remotePatterns` for Supabase Storage:
```typescript
images: {
  remotePatterns: [{ protocol: 'https', hostname: '*.supabase.co', pathname: '/storage/v1/object/public/**' }]
}
```

### 4.2 Web — Listing Detail Page

**Route:** `apps/web/app/(marketplace)/listings/[id]/page.tsx`

```typescript
type Props = { params: Promise<{ id: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params
  const listing = await getListingById(id)
  return {
    title: `${listing.title} | BuildsUp`,
    description: listing.description,
    openGraph: {
      title: listing.title,
      description: listing.description,
      images: [{ url: `/api/og?title=${encodeURIComponent(listing.title)}`, width: 1200, height: 630 }],
    },
  }
}
```

Page shows listing details, owner profile, and an "Enquire" button (links to enquiry form or sign-in).

### 4.3 Web — OG Image Route

**`apps/web/app/api/og/route.tsx`** — edge runtime, `ImageResponse`, 1200×630, accepts `title` + `description` query params.

### 4.4 Mobile — Browse Tab

**`apps/mobile/app/(tabs)/browse/index.tsx`** — `FlatList` of listing cards. Filter state managed locally. Use `supabase.from('listings').select(...)` in `useEffect`. `useLocalSearchParams` for any pre-filtered navigation.

**`apps/mobile/app/(tabs)/browse/[id].tsx`** — full listing detail. Contact button opens an enquiry modal.

### 4.5 Verification Checklist
- [ ] Web `/browse` renders listings without auth
- [ ] Filtering by `?category=materials` returns only materials listings
- [ ] Search `?q=cement` returns relevant listings (FTS working)
- [ ] `/listings/[id]` renders correct metadata in `<head>`
- [ ] `/api/og?title=Test` returns a 1200×630 PNG
- [ ] `next/image` renders Supabase storage images without `Invalid src` error
- [ ] Mobile browse tab loads listings
- [ ] Tapping a listing navigates to detail screen

---

## Phase 5: Create Listing

**Goal:** Authenticated users can post listings with images on both platforms.

### 5.1 Web — Create Listing Form

**Route:** `apps/web/app/(dashboard)/listings/new/page.tsx`

Client Component using `useActionState` (React 19, import from `'react'`). Form fields: title, description, category (select), type (select), price, location, images (file input, multiple).

**`apps/web/app/(dashboard)/listings/new/actions.ts`**
```typescript
'use server'
export async function createListing(prevState: unknown, formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // 1. Upload images first
  const files = formData.getAll('images') as File[]
  const imageUrls: string[] = []
  for (const file of files) {
    const path = `${user.id}/${Date.now()}-${file.name}`
    const { data } = await supabase.storage.from('listing-images').upload(path, file)
    if (data) {
      const { data: urlData } = supabase.storage.from('listing-images').getPublicUrl(data.path)
      imageUrls.push(urlData.publicUrl)
    }
  }

  // 2. Insert listing
  const { data, error } = await supabase.from('listings')
    .insert({ title, description, category, type, price, location, owner_id: user.id, image_urls: imageUrls })
    .select('id').single()

  if (error) return { error: error.message }
  revalidatePath('/browse')
  redirect(`/listings/${data.id}`)
}
```

### 5.2 Mobile — Post Listing Screen

**`apps/mobile/app/(tabs)/post.tsx`** — form using React Native `TextInput`, `Picker` or custom select for category/type. Image picker:

```bash
npx expo install expo-image-picker expo-file-system
# For upload:
npm install base64-arraybuffer
```

Upload pattern:
```typescript
import * as ImagePicker from 'expo-image-picker'
import * as FileSystem from 'expo-file-system'
import { decode } from 'base64-arraybuffer'

const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true })
for (const asset of result.assets ?? []) {
  const base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 })
  const arrayBuffer = decode(base64)
  await supabase.storage.from('listing-images').upload(`${userId}/${Date.now()}.jpg`, arrayBuffer, { contentType: 'image/jpeg' })
}
```

### 5.3 Verification Checklist
- [ ] Creating a listing on web redirects to `/listings/[id]`
- [ ] Listing appears on `/browse` after creation
- [ ] Image uploads to Supabase storage and URL appears in listing detail
- [ ] Attempting to create a listing without auth → redirected to login
- [ ] Mobile: image picker opens, images upload, listing saved
- [ ] DB: `owner_id` matches the authenticated user's `auth.uid()`

---

## Phase 6: Enquiries & Messaging

**Goal:** Users can contact listing owners. Real-time message delivery. Push notifications on mobile.

### 6.1 Enquiry Flow

When a logged-in user views a listing they don't own, show an "Enquire" button.

**Web** — Server Action `sendEnquiry(formData)`:
```typescript
await supabase.from('enquiries').insert({
  listing_id,
  sender_id: user.id,
  receiver_id: listing.owner_id,
  message,
})
```
Then invoke push notification edge function (see 6.3).

**Mobile** — inline modal on the listing detail screen.

### 6.2 Messages / Inbox

**Web route:** `apps/web/app/(dashboard)/messages/page.tsx` — list all enquiries where `sender_id = user.id OR receiver_id = user.id`. Group by listing. Mark as read on open.

**Mobile:** `apps/mobile/app/(tabs)/messages/index.tsx` — same query. `[id].tsx` shows the thread. Subscribe to Realtime for new messages:

```typescript
const channel = supabase.channel('user-enquiries')
  .on('postgres_changes', {
    event: 'INSERT',
    schema: 'public',
    table: 'enquiries',
    filter: `receiver_id=eq.${session.user.id}`,
  }, (payload) => {
    // Append new message to state
  })
  .subscribe()

return () => supabase.removeChannel(channel)
```

### 6.3 Push Notifications — Mobile

**Install:**
```bash
npx expo install expo-notifications expo-device expo-constants
```

**`app.json`** — add `expo-notifications` plugin.

**`apps/mobile/lib/notifications.ts`** — implement `registerForPushNotificationsAsync()`:
- Check `Device.isDevice`
- `Notifications.requestPermissionsAsync()`
- `Notifications.getExpoPushTokenAsync({ projectId: Constants.expoConfig?.extra?.eas?.projectId })`
- Save token: `supabase.from('profiles').update({ push_token: token }).eq('id', user.id)`

Call `registerForPushNotificationsAsync()` after sign-in in `_layout.tsx`.

Add listeners in `_layout.tsx`:
- `addNotificationReceivedListener` — update badge count
- `addNotificationResponseReceivedListener` — `router.push('/messages')` or to specific thread

**Supabase Edge Function:** `supabase/functions/send-enquiry-notification/index.ts` — fetches recipient's `push_token` from profiles, posts to `https://exp.host/--/api/v2/push/send`.

Invoke after `enquiries` INSERT (either from the Server Action / mobile action, or via a Supabase database webhook trigger).

### 6.4 Verification Checklist
- [ ] Enquiry created via web appears in sender's and receiver's inbox
- [ ] Realtime: open two browser tabs, send enquiry in one, inbox updates in the other without refresh
- [ ] Mobile: background app, send enquiry from another device → push notification appears
- [ ] Tapping push notification opens the correct message thread
- [ ] `is_read` updates when receiver opens the thread

---

## Phase 7: User Dashboard

**Goal:** Users can manage their listings and view their enquiries.

### 7.1 Dashboard Layout

**`apps/web/app/(dashboard)/layout.tsx`** — sidebar with links: Dashboard, My Listings, Messages, Profile. Auth check via `createClient().auth.getUser()` — redirect if no user.

**Mobile:** handled by `(tabs)` navigation (profile tab + messages tab). Dashboard = profile tab content.

### 7.2 My Listings

**Web:** `apps/web/app/(dashboard)/listings/page.tsx` — `supabase.from('listings').select('*').eq('owner_id', user.id)`. Actions: Edit, Deactivate (toggle `is_active`), Delete.

**Edit route:** `apps/web/app/(dashboard)/listings/[id]/edit/page.tsx` — pre-populated form, `updateListing` Server Action. Verify ownership server-side (don't rely on RLS alone for UX).

### 7.3 Profile

**Web:** `apps/web/app/(dashboard)/profile/page.tsx` — edit full name, phone, avatar.

Avatar upload: same storage pattern as listing images, bucket `avatars` (create separately). Path: `${user.id}/avatar.jpg` with `upsert: true`.

**Mobile:** `apps/mobile/app/(tabs)/profile.tsx` — same fields. Use `expo-image-picker` for avatar.

### 7.4 Verification Checklist
- [ ] My Listings shows only the current user's listings
- [ ] Deactivating a listing removes it from `/browse`
- [ ] Edit listing pre-fills values, saves correctly
- [ ] Delete listing removes from DB (RLS: only owner can delete)
- [ ] Profile avatar uploads and renders in listing cards

---

## Phase 8: Web SEO & Performance

**Goal:** Listing pages are fully indexable and share-ready.

### 8.1 Root Metadata

Update `apps/web/app/layout.tsx`:
```typescript
export const metadata: Metadata = {
  title: { template: '%s | BuildsUp', default: 'BuildsUp — Construction Marketplace' },
  description: 'Find and list construction materials, chemicals, services, and labour',
}
```

### 8.2 Per-Listing Metadata

Already covered in Phase 4.2. Ensure:
- `title`: `${listing.title} | BuildsUp`
- `description`: listing description truncated to 160 chars
- `openGraph.images`: points to `/api/og?title=...`
- Add `canonical` URL to prevent duplicate content

### 8.3 Sitemap

**`apps/web/app/sitemap.ts`** (Next.js built-in sitemap route):
```typescript
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const supabase = createClient() // service role or anon with public listings
  const { data: listings } = await supabase.from('listings').select('id, updated_at').eq('is_active', true)
  return [
    { url: 'https://buildsup.com', changeFrequency: 'daily', priority: 1 },
    { url: 'https://buildsup.com/browse', changeFrequency: 'hourly', priority: 0.9 },
    ...(listings ?? []).map(l => ({
      url: `https://buildsup.com/listings/${l.id}`,
      lastModified: new Date(l.updated_at),
      priority: 0.7,
    })),
  ]
}
```

### 8.4 Verification Checklist
- [ ] `<title>` on listing detail contains listing title
- [ ] `<meta og:image>` points to the OG image route and returns correct image
- [ ] `/sitemap.xml` lists all active listings
- [ ] Lighthouse score ≥ 90 on `/browse`
- [ ] `next/image` serves WebP with correct `sizes` attribute

---

## Phase 9: Final Verification

### Type Safety
- [ ] `pnpm type-check` passes with zero errors across all packages
- [ ] Run `supabase gen types typescript --project-id <ref>` and import `Database` type into both apps' Supabase clients

### Security
- [ ] RLS: confirm anon user cannot insert a listing (test in Supabase SQL editor: `SET ROLE anon; INSERT INTO listings...`)
- [ ] RLS: confirm authenticated user A cannot update user B's listing
- [ ] Supabase service role key is never in client-side code or `.env.local` (only in Edge Functions via env)
- [ ] No `.env*` files committed: `git grep -r "SUPABASE_KEY"` returns nothing in committed files

### Performance
- [ ] `pnpm build` completes without errors for both apps
- [ ] Mobile: `pnpm --filter mobile start` + Expo Go on physical device — no Metro bundler errors

---

## Dependency Install Summary

### `apps/web`
```bash
# Already installed: @supabase/supabase-js @supabase/ssr next react react-dom tailwindcss typescript
# No additional deps needed for core features
```

### `apps/mobile`
```bash
npx expo install \
  @react-native-async-storage/async-storage \
  react-native-url-polyfill \
  expo-linking \
  expo-image-picker \
  expo-file-system \
  expo-notifications \
  expo-device \
  expo-constants

npm install base64-arraybuffer
```

---

## File Reference Map

| Feature | Web file | Mobile file |
|---|---|---|
| Supabase client (browser) | `lib/supabase/client.ts` | `lib/supabase.ts` |
| Supabase client (server) | `lib/supabase/server.ts` | — |
| Auth middleware | `middleware.ts` + `lib/supabase/middleware.ts` | `app/_layout.tsx` |
| Auth callback | `app/auth/callback/route.ts` | `app/_layout.tsx` (Linking) |
| Sign in/up | `app/(auth)/login/` | `app/(auth)/sign-in.tsx` |
| Browse | `app/(marketplace)/browse/page.tsx` | `app/(tabs)/browse/index.tsx` |
| Listing detail | `app/(marketplace)/listings/[id]/page.tsx` | `app/(tabs)/browse/[id].tsx` |
| Create listing | `app/(dashboard)/listings/new/` | `app/(tabs)/post.tsx` |
| Messages | `app/(dashboard)/messages/` | `app/(tabs)/messages/` |
| Dashboard | `app/(dashboard)/dashboard/page.tsx` | `app/(tabs)/profile.tsx` |
| OG image | `app/api/og/route.tsx` | — |
| Push notifications | — | `lib/notifications.ts` |
| Push edge function | `supabase/functions/send-enquiry-notification/` | — |
