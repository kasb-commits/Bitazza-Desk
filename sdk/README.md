# CSBot React Native SDK — Developer Guide

## Quick start

```bash
cd sdk
npm install --legacy-peer-deps   # installs all workspace packages

# Run all tests
npm test

# Run only core tests (fast, no React Native required)
npm run test:core

# Run GL language detection tests
npm run test:gl

# TypeScript check (no emit)
npm run typecheck
```

## Running the mock server (required for example app)

```bash
cd sdk/mock-server
npm install          # only needs ws package
node server.js       # starts on http://localhost:8001
```

The mock server implements all SDK endpoints with fixture data:

| Endpoint | Behaviour |
|---|---|
| `POST /chat/start` | Returns `conv-id: mock-conv-001` |
| `POST /chat/message` | Echoes user message with `[MOCK]` prefix |
| `POST /push` | Broadcasts an agent message over WS to all connected clients |
| `/ws/:convId` | Full WS server — requires `{"type":"auth","token":...}` first frame |
| `GET /health` | Returns `{status:"ok",rooms:N}` |

**Simulate a human agent replying:**
```bash
curl -X POST http://localhost:8001/push \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"mock-conv-001","content":"Hi, I am Sara from support!","agentName":"Sara"}'
```

## Running the example Expo app

```bash
# Requires: Expo CLI, iOS Simulator or Android Emulator
cd sdk/example
npm install
npx expo start --ios     # or --android
```

The example app shows both TH and GL widgets side-by-side with a toggle.
Point `API_URL` in `App.tsx` to the mock server (`http://localhost:8001`).

> **Android**: Use `http://10.0.2.2:8001` instead of `localhost` in `App.tsx`.

## Test structure

```
sdk/
├── packages/core/__tests__/
│   ├── storage.test.ts         – StorageAdapter implementations
│   ├── session.test.ts         – Session CRUD + TTL expiry
│   ├── api.test.ts             – All 12 API functions (fetch mocked)
│   ├── ws.test.ts              – ConversationSocket state machine + reconnect
│   └── useConversation.test.tsx – Full hook integration (renderHook + mocked fetch/WS)
└── packages/react-native-gl/__tests__/
    └── languageDetection.test.ts – detectLanguage() with Unicode ranges + locale fallback
```

## What's tested vs what requires a device

| Area | Covered by Jest | Requires simulator |
|---|---|---|
| Storage adapters | ✅ | — |
| Session CRUD + TTL | ✅ | — |
| All API functions | ✅ (fetch mocked) | — |
| WS reconnect / ping / backoff | ✅ (MockWebSocket) | — |
| Full hook state machine | ✅ (renderHook) | — |
| GL language detection | ✅ | — |
| TH/GL component rendering | — | ✅ (example app) |
| Keyboard avoiding / animations | — | ✅ |
| AsyncStorage integration | — | ✅ |
| Push notifications / sound | — | ✅ |

## Integration checklist (for dev team)

Before shipping to production:

- [ ] Run `npm test` — all 40+ tests must pass
- [ ] Run `npm run typecheck` — 0 errors
- [ ] Start mock server; run example app on iOS Simulator
  - [ ] TH widget: EN → category picker → send message → receives bot reply
  - [ ] TH widget: switch to TH → Thai UI rendered
  - [ ] GL widget: switch to GL → EN/ZH/MS/VI/ID language picker
  - [ ] Both widgets: FAB tap opens modal; X closes it
  - [ ] Simulate agent reply via `/push` — appears in chat without page reload
- [ ] Run example app on Android Emulator (use 10.0.2.2)
- [ ] Connect to real backend (staging) with a valid JWT — verify auth handshake

## Known limitations

- VI and ID category labels in the GL package are stubs (`// TODO: localization`).
  Do not ship GL to production until these are filled in.
- `notify.mp3` in `packages/react-native-th/src/assets/` must be provided by the host app.
  The SDK references `require('./assets/notify.mp3')` — if the file is absent, sound is silent.
- The example app uses `workspace:*` deps resolved by npm workspaces.
  When publishing the packages to a private registry, update deps to real version ranges.
