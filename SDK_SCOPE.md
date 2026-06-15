# CS Bot SDK — Full Scope Document

**For:** Engineering team building the SDK  
**Date:** 2026-06-03  
**Covers:** Bitazza TH SDK + Bitazza GL SDK

---

## 0. Repository Structure

The SDK lives in the **same repo** as the rest of the project, under a new `sdk/` directory alongside `frontend/`, `api/`, and `dashboard/`. It is distributed via private npm — the Bitazza native team installs packages from the registry and never clones this repo.

```
CS BOT/
├── api/                          ← FastAPI backend
├── engine/                       ← AI core
├── db/                           ← DB layer + migrations
├── dashboard/                    ← CS agent dashboard
├── frontend/
│   └── widget/                   ← Existing web widget (eventually imports from sdk/core)
└── sdk/
    ├── package.json              ← npm workspace root
    └── packages/
        ├── core/                 ← @bitazza/csbot-core (platform-agnostic)
        ├── react-native-th/      ← @bitazza/csbot-react-native-th
        └── react-native-gl/      ← @bitazza/csbot-react-native-gl
```

**Why same repo:**
- `core` shares types and API logic with the existing web widget — one source of truth, no version-bump coordination across repos
- The SDK has no imports from `api/`, `engine/`, or `db/` — it is cleanly isolated within `sdk/`
- Distribution is via npm registry, so the Bitazza team has no visibility into the rest of the repo

---

## 1. Region Handling — Validation & Decision

### Current state (verified against code)

The existing web widget has **no region awareness whatsoever**:

- `channel` is hardcoded to `'web'` in `db/conversation_store.py:301` regardless of what `platform` is sent
- `region` does not exist in any DB table, API response, or dashboard column
- The `platform` field (`freedom` | `bitazza` | `web`) is logged but **never persisted** to the tickets table
- The Bitazza integration requirements doc adds `region` to the `/user` API response (`"region": "GL"`) but nothing in our codebase reads or stores it yet

### How should region work?

The web widget **cannot determine region on its own** — it has no way to know whether it is embedded in Bitazza TH or Bitazza GL without being told. This is the same constraint the SDK faces. There are two design options:

**Option A — Region via JWT (recommended)**
Bitazza mints a JWT that includes `region` alongside `sub`:
```json
{ "sub": "USR-001", "region": "GL", "exp": 1234567890 }
```
The SDK reads it from the decoded token on connection. The API middleware extracts it and passes it to `create_conversation`. This is the cleanest approach: region is bound to the authenticated user identity, survives token refresh, and never requires the SDK consumer to pass it separately.

**Option B — Region as SDK config parameter**
The host app passes region explicitly:
```tsx
<CSBotWidget region="GL" token={userJwt} ... />
```
Simpler to implement on our side, but duplicates information (Bitazza already knows the user's region) and adds an integration burden on the host app team.

**Recommendation: Option A.** The JWT already flows through the system; adding one claim is trivial on Bitazza's side and eliminates any risk of mismatch between the token's region and the config param.

### What needs to change on our side for region

1. **`api/middleware/auth.py`** — extract `region` from JWT payload alongside `user_id`
2. **`api/routes/chat.py`** — accept `region` from middleware, pass to `create_conversation`
3. **`db/conversation_store.py`** — store `region` on the `tickets` row (`ALTER TABLE tickets ADD COLUMN region TEXT`)
4. **`db/migrations/`** — new migration `013_ticket_region.sql`
5. **Dashboard** — display `region` badge on ticket card and ticket detail view

These are backend changes, not SDK changes. The SDK's only responsibility is to pass the JWT (which contains region) — exactly what it already does.

---

## 2. SDK Overview

Two separate SDK packages, sharing one core library:

```
@bitazza/csbot-core              ← platform-agnostic: API, WebSocket, state, types
@bitazza/csbot-react-native-th   ← TH UI: EN + TH only
@bitazza/csbot-react-native-gl   ← GL UI: EN + additional GL languages
```

The TH and GL SDKs are identical in architecture. They differ only in:
- Supported language list
- Default language fallback
- Category labels per language

---

## 3. Core Package — `@bitazza/csbot-core`

Everything in this package is platform-agnostic (no DOM, no RN, no browser APIs). It can be used by the web widget too.

### 2.1 `StorageAdapter` interface

```typescript
export interface StorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}
```

Implementations provided per platform:
- **Web:** `LocalStorageAdapter` (wraps `localStorage` in async interface)
- **React Native:** `AsyncStorageAdapter` (wraps `@react-native-async-storage/async-storage`)

### 2.2 Session management — `session.ts`

Extracted from `frontend/widget/src/api.ts` lines 9–83. Replaces all `localStorage` calls with `StorageAdapter`.

| Function | Description |
|---|---|
| `getStoredSession(adapter)` | Read session from storage; evict if TTL (3h) elapsed |
| `storeSession(adapter, id, fields)` | Write/merge session to storage |
| `clearStoredSession(adapter)` | Remove session entry |
| `getStoredCustomerId(adapter)` | Read permanent customer ID |
| `storeCustomerId(adapter, id)` | Write permanent customer ID |
| `storeSessionLang(adapter, lang)` | Merge-update language into existing session |
| `storeSessionCategory(adapter, category)` | Merge-update category into existing session |
| `storeSessionAgent(adapter, agent)` | Merge-update agent identity into existing session |

Session TTL: 3 hours (configurable via `CSBotConfig.sessionTtlMs`).

### 2.3 API client — `api.ts`

Refactored from `frontend/widget/src/api.ts`. `fetch()` is unchanged (native in both web and RN). `StorageAdapter` is injected.

| Function | Endpoint | Notes |
|---|---|---|
| `startConversation(cfg, adapter, opts?)` | `POST /chat/start` | `opts`: `guestName`, `guestEmail` |
| `greetConversation(cfg, convId, lang)` | `POST /chat/greet` | |
| `setCategoryAgent(cfg, convId, category)` | `POST /chat/set-category` | |
| `sendMessage(cfg, convId, message, opts?)` | `POST /chat/message` | `opts`: `category`, `attachmentIds` |
| `fetchHistory(cfg, convId)` | `GET /chat/history/{id}` | |
| `fetchPaginatedHistory(cfg, convId, page, limit)` | `GET /chat/history/{id}?page=&limit=` | |
| `fetchCustomerTickets(cfg, page, limit)` | `GET /chat/customer-tickets` | |
| `fetchOpenTicket(cfg)` | `GET /chat/open-ticket` | |
| `submitCsat(cfg, ticketId, score)` | `POST /chat/csat` | score: 1–5 |

All functions add `Authorization: Bearer <token>` header when `cfg.token` is present.

### 2.4 WebSocket client — `ws.ts`

New file (does not exist in the web widget — it uses polling). This is the most important improvement for mobile.

```typescript
class ConversationSocket {
  connect(convId: string, apiUrl: string): void
  disconnect(): void
  onMessage(handler: (msg: WsInboundMessage) => void): void
  send(msg: WsOutboundMessage): void
  get state(): 'connecting' | 'open' | 'closed' | 'reconnecting'
}
```

**Inbound message types** (from server):
```typescript
type WsInboundMessage =
  | { type: 'pong' }
  | { type: 'new_message'; message: AgentMessage }
  | { type: 'status_change'; status: TicketStatus }
  | { type: 'bot_message'; content: string }
```

**Outbound message types** (from SDK):
```typescript
type WsOutboundMessage = { type: 'ping' }
```

**Reconnect behavior:**
- Exponential backoff: 1s → 2s → 4s → 8s → 16s → 30s (cap)
- Reconnects on `onclose` unless `disconnect()` was called intentionally
- On reconnect: re-registers the same conversation_id (server is stateless)
- Ping sent every 25s to keep connection alive through mobile NAT timeouts

**Fallback polling:**
- When WS is in `reconnecting` state for > 10s, enable 5s REST polling of `/chat/history` as fallback
- Disable polling when WS reconnects successfully

### 2.5 State machine — `useConversation.ts`

Extracted from `frontend/widget/src/ChatWindow.tsx` (24 state vars collapsed into a coherent hook). This is the central logic that both TH and GL UI packages consume.

```typescript
export function useConversation(
  cfg: CSBotSDKConfig,
  storage: StorageAdapter,
): ConversationState & ConversationActions
```

**State:**
```typescript
interface ConversationState {
  messages: Message[];
  loading: boolean;
  convId: string | null;
  lang: SupportedLanguage;
  langSelected: boolean;
  selectedCategory: IssueCategory | null;
  escalated: boolean;
  escalatedAgent: AgentIdentity | null;
  botName: string | null;
  botAvatarUrl: string | null;
  csatPending: boolean;
  csatSubmitted: boolean;
  prevTickets: PastTicket[];
  openTicket: PastTicket | null;
  isGuest: boolean;
  wsState: 'connecting' | 'open' | 'closed' | 'reconnecting';
  error: string | null;
}
```

**Actions:**
```typescript
interface ConversationActions {
  send(text: string, attachmentIds?: string[]): Promise<void>;
  selectCategory(cat: IssueCategory): Promise<void>;
  selectLanguage(lang: SupportedLanguage): void;
  submitCsat(score: 1 | 2 | 3 | 4 | 5): Promise<void>;
  declineResolution(): void;
  resumeTicket(ticketId: string): Promise<void>;
  startGuestSession(name: string, email: string): Promise<void>;
  reset(): void;  // clear session and start fresh
}
```

**Lifecycle managed by the hook:**
1. On mount: restore session from storage → fetch history → open WebSocket
2. WS `new_message` → append to messages, play notification sound (via injected callback)
3. WS `status_change` → update escalation state
4. On send: optimistically add user message → POST → add bot reply (or null if human)
5. On unmount: close WebSocket, cancel pending timers

### 2.6 Types — `types.ts`

```typescript
// Languages
type SupportedLanguage = string;  // 'en' | 'th' | 'zh' | 'ms' | etc — open-ended

// Config
interface CSBotSDKConfig {
  platform: 'bitazza' | 'freedom' | 'web';
  apiUrl: string;
  token?: string;
  primaryColor?: string;           // hex, default '#1a56db'
  lang?: SupportedLanguage;        // override auto-detect
  supportedLanguages: SupportedLanguage[];  // GL: many; TH: ['en', 'th']
  sessionTtlMs?: number;           // default: 3 * 60 * 60 * 1000
  onEscalated?: () => void;        // optional host-app callback
  onCsatComplete?: () => void;
  onNotificationSound?: () => void; // host app provides audio (platform-specific)
}

// Issue categories
type IssueCategory =
  | 'kyc_verification'
  | 'account_restriction'
  | 'password_2fa_reset'
  | 'fraud_security'
  | 'withdrawal_issue'
  | 'other';

// Category definition (localised per SDK)
interface IssueCategoryDef {
  key: IssueCategory;
  icon: string;
  label: Record<SupportedLanguage, string>;
  openingMessage: Record<SupportedLanguage, string>;
}

// Messages
type MessageRole = 'user' | 'assistant' | 'agent';

interface Message {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  escalated?: boolean;
  agentName?: string;
  agentAvatar?: string;
  agentAvatarUrl?: string;
  offerResolution?: boolean;
  senderName?: string;
  attachments?: AttachmentMeta[];
}

interface AttachmentMeta {
  id: string;
  url: string;
  name: string;
  mimeType: string;
  size: number;
}

interface AgentIdentity {
  name: string;
  avatar: string;
  avatarUrl: string | null;
}

interface PastTicket {
  id: string;
  category: string;
  status: string;
  createdAt: number;
  lastMessage: string | null;
  lastMessageAt: number | null;
}

type TicketStatus =
  | 'Open_Live'
  | 'In_Progress'
  | 'Pending_Customer'
  | 'Escalated'
  | 'Closed_Resolved'
  | 'Closed_Unresponsive';
```

---

## 4. React Native Package — TH

### Package name: `@bitazza/csbot-react-native-th`

### 3.1 Supported languages
`['en', 'th']` — identical to current web widget

### 3.2 Category labels
```typescript
const ISSUE_CATEGORIES_TH: IssueCategoryDef[] = [
  {
    key: 'kyc_verification',
    icon: '🪪',
    label: { en: 'KYC / Verification', th: 'ยืนยันตัวตน (KYC)' },
    openingMessage: { en: 'I need help with my KYC verification.', th: 'ฉันต้องการความช่วยเหลือเกี่ยวกับการยืนยันตัวตน KYC' },
  },
  // ... same 6 categories as web widget
];
```

### 3.3 Components

#### `CSBotWidget` (entry point)
```tsx
<CSBotWidget
  apiUrl="https://csbot-api-production.up.railway.app"
  token={userJwt}
  platform="bitazza"
  primaryColor="#1a56db"
/>
```
- Renders floating action button (circular, `position: 'absolute'`, bottom-right)
- Animated FAB ring (RN `Animated.loop` replacing CSS `animate-ping`)
- Opens `ChatWindow` inside an RN `Modal` on tap
- Slide-up modal animation via `react-native-reanimated`

#### `ChatWindow`
- Calls `useConversation(cfg, asyncStorageAdapter)`
- `KeyboardAvoidingView` wrapper (handles soft keyboard on both iOS and Android)
- Header: agent avatar (image or initial letter), agent name, close button
- Message list: `FlatList` with `inverted={false}`, `ref.scrollToEnd()` on new message
- Typing indicator: shown while `loading === true`
- Category picker: shown when `selectedCategory === null`
- Guest identity form: shown when `isGuest` and no name/email submitted
- Input bar: `TextInput` (multiline, max 3 lines) + send button + attachment button
- CSAT stars: rendered when `csatPending === true`
- Previous tickets: `PrevConversations` component
- Resume open ticket banner: shown when `openTicket !== null`

#### `MessageBubble`
- User messages: right-aligned, `primaryColor` background
- Bot/agent messages: left-aligned, neutral background
- Avatar: `Image` component with `uri` source, or initial-letter view
- Timestamp: `new Date(timestamp).toLocaleTimeString(lang)`
- Supports `offerResolution` banner (resolve / not resolved buttons)

#### `CategoryPicker`
- 2-column grid of `Pressable` cards
- Per-category accent colors (hardcoded palette matching web widget)
- Props: `lang`, `primaryColor`, `onSelect`, `disabled`

#### `TypingIndicator`
- 3 dots with staggered `Animated.sequence` bounce animation

#### `PrevConversations`
- `FlatList` of past tickets
- Each ticket expands to show paginated message history
- Infinite scroll: `onEndReached` triggers `fetchPaginatedHistory`

#### `GuestIdentityForm`
- `TextInput` for name and email
- Skip and Start Chat buttons

### 3.4 AsyncStorage adapter
```typescript
import AsyncStorage from '@react-native-async-storage/async-storage';
export const asyncStorageAdapter: StorageAdapter = {
  getItem: (key) => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
  removeItem: (key) => AsyncStorage.removeItem(key),
};
```

### 3.5 Notification sound
The core package calls `cfg.onNotificationSound()` (if provided) when an agent message arrives via WS. The TH package exports a ready-made implementation:
```typescript
import { Audio } from 'expo-av';
export async function defaultNotificationSound() {
  if (AppState.currentState !== 'active') return;  // no sound when backgrounded
  const { sound } = await Audio.Sound.createAsync(require('./assets/notify.mp3'));
  await sound.playAsync();
}
```
The host app passes this to `CSBotWidget` or uses their own.

### 3.6 Styling approach
`StyleSheet.create()` with a `buildTheme(primaryColor)` function. No Tailwind, no CSS-in-JS library.

### 3.7 Dependencies
```json
{
  "peerDependencies": {
    "react": ">=18",
    "react-native": ">=0.73",
    "@react-native-async-storage/async-storage": ">=1.23"
  },
  "dependencies": {
    "@bitazza/csbot-core": "workspace:*",
    "react-native-reanimated": ">=3",
    "uuid": "^9"
  },
  "optionalDependencies": {
    "expo-av": "*",
    "expo-linear-gradient": "*"
  }
}
```

---

## 5. React Native Package — GL

### Package name: `@bitazza/csbot-react-native-gl`

### 4.1 Difference from TH package
Everything is identical except:

| | TH | GL |
|---|---|---|
| `supportedLanguages` default | `['en', 'th']` | `['en', 'zh', 'ms', 'vi', 'id']` *(exact list TBD with product)* |
| Default fallback language | `'en'` | `'en'` |
| Category labels | EN + TH | EN + all GL languages |
| Language picker UI | Shows EN / TH toggle | Shows all GL languages (dropdown or radio list) |
| Auto-detect logic | Thai Unicode range → 'th'; else 'en' | Extended: detect from Unicode ranges or `navigator.language` / device locale |

All components, hooks, adapters, and dependencies are identical. The GL package imports `@bitazza/csbot-core` and re-exports everything from the TH package, replacing only:
- `ISSUE_CATEGORIES` constant (GL-localised labels)
- `DEFAULT_SUPPORTED_LANGUAGES` constant
- Language detection logic in `useConversation`

### 4.2 Language detection for GL
```typescript
function detectLanguage(
  text: string,
  deviceLocale: string,
  supported: SupportedLanguage[],
): SupportedLanguage {
  // 1. Check Unicode script ranges in text
  // 2. Fall back to deviceLocale (RN: Localization.locale from expo-localization)
  // 3. Fall back to 'en'
  // Always clamp to supportedLanguages list
}
```

The device locale (`expo-localization` or `react-native-localize`) is available in RN — this is an advantage over the web widget which can only inspect the message text.

---

## 6. Region — What the SDK Does

The SDK's only region-related responsibility is **passing the JWT**. Region is encoded in the JWT by Bitazza's auth system (see Section 0). The SDK does not parse the JWT or read the region claim directly.

On the backend side (separate work, not part of the SDK build):
- Middleware extracts `region` from JWT
- `create_conversation` stores it on the ticket
- Dashboard shows the region badge

The SDK consumer does not pass region explicitly — it flows through the token automatically. This means **one SDK package works for both TH and GL users** as long as the token is correct. The separate TH and GL packages exist for language support differences, not for region routing.

---

## 7. File / Attachment Support

The current web widget supports file attachments (escalates on attachment). The SDK must support the same flow:

| Function | Description |
|---|---|
| `pickFile()` | Launch native file picker (React Native `expo-document-picker` or `react-native-document-picker`) |
| `pickImage()` | Launch native image picker (`expo-image-picker`) |
| `uploadAttachment(cfg, file)` | `POST /api/uploads/attachment` — multipart form; returns `{ id, url, name, mime_type, size }` |

The UI shows a thumbnail or file name in the message bubble after upload. The `attachmentIds` array is passed in `sendMessage`.

---

## 8. Backend Changes Required (not SDK work, but must be done before SDK launch)

| # | Change | File | Notes |
|---|---|---|---|
| 1 | Extract `region` from JWT in middleware | `api/middleware/auth.py` | Add `region` to returned payload |
| 2 | Accept and store `region` in `create_conversation` | `db/conversation_store.py` | New `region` parameter |
| 3 | Pass `region` from `/chat/start` handler | `api/routes/chat.py` | From middleware to DB call |
| 4 | DB migration — add `region` column to `tickets` | `db/migrations/013_ticket_region.sql` | `ALTER TABLE tickets ADD COLUMN region TEXT` |
| 5 | Dashboard — display region badge on ticket | `dashboard/src/` | Visual indicator on ticket card |
| 6 | Persist `platform` to `tickets.channel` | `db/conversation_store.py:301` | Currently hardcoded `'web'`; should use `platform` value so SDK tickets show differently from web |

---

## 9. Out of Scope for This Build

- **Push notifications** — requires APNs/FCM integration; separate project
- **WebView embed** — simpler alternative; not needed if native SDK is built
- **Web widget migration to `@bitazza/csbot-core`** — additive change; not required to ship SDK
- **iOS/Android separate native modules** — not needed; all deps are JS-only
- **KYC document camera capture** — not in current web widget; out of scope

---

## 10. Deliverables Checklist

**Core package (`@bitazza/csbot-core`)**
- [ ] `StorageAdapter` interface
- [ ] `LocalStorageAdapter` (web)
- [ ] `session.ts` with all 8 session functions
- [ ] `api.ts` with all 9 API functions
- [ ] `ws.ts` — WebSocket client with reconnect + ping + fallback polling
- [ ] `useConversation.ts` — full state machine hook
- [ ] `types.ts` — all shared types

**TH package (`@bitazza/csbot-react-native-th`)**
- [ ] `AsyncStorageAdapter`
- [ ] `CSBotWidget` (FAB + Modal)
- [ ] `ChatWindow`
- [ ] `MessageBubble`
- [ ] `CategoryPicker` (EN + TH labels)
- [ ] `TypingIndicator`
- [ ] `PrevConversations`
- [ ] `GuestIdentityForm`
- [ ] `defaultNotificationSound`
- [ ] `buildTheme(primaryColor)`
- [ ] Published to private npm registry
- [ ] Smoke tested on iOS Simulator + Android Emulator

**GL package (`@bitazza/csbot-react-native-gl`)**
- [ ] Extended language detection
- [ ] `ISSUE_CATEGORIES` with GL language labels
- [ ] Language picker UI (dropdown for multiple languages)
- [ ] Everything else re-exported from TH package
- [ ] Published to private npm registry
- [ ] Smoke tested on iOS Simulator + Android Emulator

**Backend (prerequisite)**
- [ ] Migration 013 (`region` column on `tickets`)
- [ ] JWT middleware updated to extract `region`
- [ ] `create_conversation` stores `region`
- [ ] `platform` stored as `channel` (not hardcoded `'web'`)
- [ ] Dashboard region badge
