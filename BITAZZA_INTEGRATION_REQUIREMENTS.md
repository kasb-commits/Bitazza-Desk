# CS Bot — Bitazza Integration Requirements

**For:** Bitazza Backend Team  
**Version:** 1.0  
**Date:** 2026-05-14

This document lists everything the Bitazza backend team needs to provide for the CS Bot to go live in production. The bot is fully built and running in staging with mock data. Switching to production requires only the items below.

---

## 1. Widget Authentication

### What we need
When a logged-in user opens the CS Bot widget inside the Bitazza app or website, Bitazza must supply a short-lived signed JWT identifying that user.

### How it works
Before the widget script loads, the host page sets:

```html
<script>
  window.CSBotConfig = {
    platform: 'bitazza',
    apiUrl: 'https://csbot-api-production.up.railway.app',
    token: '<JWT_SIGNED_BY_BITAZZA>',
  };
</script>
<script src="https://your-cdn.com/widget.iife.js"></script>
```

### JWT format
```json
Header:  { "alg": "HS256", "typ": "JWT" }
Payload: { "sub": "<bitazza_user_id>", "exp": <unix_timestamp> }
```

- Signed with a shared secret (`JWT_SECRET`) — we provide this value and store it in our Railway env
- `exp` should be **1 hour** from issuance (the widget refreshes the page on expiry)
- `sub` must be the user's stable internal Bitazza user ID (e.g. `USR-001`) — this is the ID we use for all subsequent account data lookups

### Our side
No new endpoint needed. Our existing auth middleware already accepts any valid JWT with a `sub` claim.

---

## 2. User Profile + KYC API

### Endpoint
```
GET {USER_API_BASE_URL}/user?user_id=<id>
Authorization: Bearer <USER_API_KEY>
```

- `USER_API_BASE_URL` and `USER_API_KEY` are env vars we set on our side
- `USER_API_KEY` is an API key Bitazza provides; we send it as a Bearer token on every request
- Server should be IP-whitelisted to our Railway service IP for additional security

### Expected response
```json
{
  "user_id": "USR-001",
  "first_name": "Somchai",
  "last_name": "Rakdee",
  "email": "somchai@example.com",
  "phone": "+66812345678",
  "tier": "regular",
  "region": "GL",
  "kyc": {
    "status": "approved",
    "rejection_reason": null,
    "reviewed_at": "2024-11-01T09:00:00Z"
  }
}
```

**`tier` values:** `regular` | `VIP` | `EA` | `High net worth`

**`kyc.status` values:** `approved` | `rejected` | `pending_information` | `pending_review` | `not_started` | `suspended` | `expired`

- `rejection_reason`: string, only populated when `kyc.status == "rejected"`, otherwise `null`
- `reviewed_at`: ISO-8601 datetime string, `null` if not yet reviewed

**Error responses:**
```json
{ "error": "user_not_found" }   // HTTP 404
{ "error": "unauthorized" }     // HTTP 401
```

---

## 3. Account Restrictions API

### Endpoint
```
GET {USER_API_BASE_URL}/restrictions?user_id=<id>
Authorization: Bearer <USER_API_KEY>
```

Same base URL and API key as the user profile endpoint above.

### Expected response
```json
{
  "user_id": "USR-001",
  "has_restrictions": true,
  "trading_available": false,
  "trading_block_reason": "Account frozen pending fraud investigation.",
  "restrictions": [
    {
      "restriction_id": "RST-001",
      "type": "full_freeze",
      "status": "active",
      "reason": "Suspicious activity detected.",
      "applied_at": "2025-01-15T08:00:00Z",
      "expected_lift_at": null,
      "can_self_resolve": false,
      "resolution_steps": null
    }
  ]
}
```

**`type` values:** `deposit_block` | `withdrawal_block` | `trading_block` | `full_freeze` | `login_block`

**`status` values:** `active` | `under_review` | `lifted`

- `expected_lift_at`: ISO-8601 datetime or `null` (indefinite)
- `can_self_resolve`: `true` if the user can fix it themselves (e.g. complete KYC)
- `resolution_steps`: plain-text instructions shown to the user, only populated when `can_self_resolve == true`

**When no restrictions exist:**
```json
{
  "user_id": "USR-001",
  "has_restrictions": false,
  "trading_available": true,
  "trading_block_reason": null,
  "restrictions": []
}
```

---

## 4. Deposits API

### Endpoint
```
GET {BITAZZA_API_URL}/internal/users/{user_id}/deposits
GET {BITAZZA_API_URL}/internal/users/{user_id}/deposits/{tx_id}
x-internal-api-key: <INTERNAL_API_KEY>
```

- `BITAZZA_API_URL` and `INTERNAL_API_KEY` are env vars we set on our side
- First form returns up to 5 most recent deposits
- Second form returns a single deposit matched by `transaction_id`, `tx_hash`, or `bank_ref`

### Expected response (list)
```json
{
  "transactions": [
    {
      "transaction_id": "TXN-001",
      "type": "deposit",
      "status": "completed",
      "currency": "BTC",
      "amount": 0.5,
      "fee": 0.0001,
      "network": "BTC",
      "tx_hash": "abc123def456...",
      "bank_ref": null,
      "created_at": "2025-03-10T12:00:00Z",
      "completed_at": "2025-03-10T12:15:00Z"
    }
  ],
  "total": 12
}
```

**`status` values:** `completed` | `pending` | `failed` | `cancelled`

- `network`: blockchain network (e.g. `BTC`, `TRC20`, `ERC20`) or payment method (e.g. `PromptPay`) — `null` if not applicable
- `tx_hash`: on-chain transaction hash for crypto deposits, `null` for fiat
- `bank_ref`: bank reference number for fiat deposits, `null` for crypto
- `completed_at`: ISO-8601 or `null` if not yet completed
- `total`: total count of all deposits for this user (not just this page)

### Expected response (single)
Same object as one item in the list above, not wrapped in an array.

**Not found:**
```json
{ "error": "transaction_not_found", "tx_id": "TXN-999" }
```

---

## 5. Withdrawals API

### Endpoint
```
GET {BITAZZA_API_URL}/internal/users/{user_id}/withdrawals
GET {BITAZZA_API_URL}/internal/users/{user_id}/withdrawals/{tx_id}
x-internal-api-key: <INTERNAL_API_KEY>
```

### Expected response
Identical shape to the Deposits API above, with `"type": "withdrawal"`.

---

## 6. Spot Orders API

### Endpoint
```
GET {BITAZZA_API_URL}/internal/users/{user_id}/spot-orders
GET {BITAZZA_API_URL}/internal/users/{user_id}/spot-orders/{order_id}
x-internal-api-key: <INTERNAL_API_KEY>
```

### Expected response (list)
```json
{
  "orders": [
    {
      "order_id": "SPT-001-001",
      "symbol": "BTC/THB",
      "side": "buy",
      "order_type": "limit",
      "status": "filled",
      "price": 1500000.0,
      "quantity": 0.1,
      "filled_qty": 0.1,
      "fee": 150.0,
      "fee_currency": "THB",
      "created_at": "2025-03-10T10:00:00Z",
      "updated_at": "2025-03-10T10:02:00Z"
    }
  ],
  "total": 5
}
```

**`side` values:** `buy` | `sell`  
**`order_type` values:** `limit` | `market`  
**`status` values:** `filled` | `partially_filled` | `cancelled` | `open`

---

## 7. Futures Positions API

### Endpoint
```
GET {BITAZZA_API_URL}/internal/users/{user_id}/futures-positions
GET {BITAZZA_API_URL}/internal/users/{user_id}/futures-positions/{position_id}
x-internal-api-key: <INTERNAL_API_KEY>
```

### Expected response (list)
```json
{
  "positions": [
    {
      "position_id": "FUT-001-001",
      "symbol": "BTCUSDT-PERP",
      "side": "long",
      "status": "closed",
      "leverage": 10,
      "entry_price": 42000.0,
      "exit_price": 45000.0,
      "quantity": 0.01,
      "pnl": 30.0,
      "fee": 0.84,
      "liquidation_price": 38000.0,
      "created_at": "2025-03-01T08:00:00Z",
      "closed_at": "2025-03-05T14:30:00Z"
    }
  ],
  "total": 3
}
```

**`side` values:** `long` | `short`  
**`status` values:** `open` | `closed` | `liquidated`

- `exit_price`, `pnl`, `closed_at`: `null` when position is still `open`
- `liquidation_price`: `null` if position was closed normally

---

## 8. Account Balances API

### Endpoint
```
GET {BITAZZA_API_URL}/internal/users/{user_id}/balances
x-internal-api-key: <INTERNAL_API_KEY>
```

### Expected response
```json
{
  "user_id": "USR-001",
  "balances": [
    { "currency": "BTC",  "available": 0.45,    "locked": 0.05 },
    { "currency": "THB",  "available": 50000.0, "locked": 0.0 },
    { "currency": "USDT", "available": 200.0,   "locked": 0.0 }
  ]
}
```

- `available`: funds the user can withdraw or trade
- `locked`: funds held in open orders

---

## 9. File Storage

### Why it's needed
The bot collects screenshots and file attachments from customers during support conversations. These files must survive service restarts and redeployments — the API server's local disk is ephemeral and cannot be relied on for persistence.

### What's required
A persistent object storage bucket accessible to the CS Bot API service:

- The API must be able to **write** files to the bucket (uploads from customers and agents)
- Files must be **publicly readable via a stable URL** — these URLs are embedded in ticket messages and forwarded to CS agents
- No CDN or pre-signed URL complexity is required; simple public read access is sufficient for this use case

### Env vars we need
```
STORAGE_BUCKET_NAME      — bucket name
STORAGE_ACCESS_KEY_ID    — write access credentials
STORAGE_SECRET_ACCESS_KEY
STORAGE_ENDPOINT_URL     — S3-compatible endpoint (omit if using AWS S3 directly)
STORAGE_PUBLIC_BASE_URL  — base URL used to construct public file URLs
```

### Our side
One function in `api/routes/uploads.py` handles all file saves. Switching from local disk to the bucket requires only updating that function — no other code changes.

---

## Summary Checklist

| # | What | Who provides | Status |
|---|------|-------------|--------|
| 1 | `JWT_SECRET` — shared signing secret for widget auth | Bitazza generates, shares with us securely | Pending |
| 2 | `USER_API_BASE_URL` — base URL for `/user` and `/restrictions` | Bitazza | Pending |
| 3 | `USER_API_KEY` — Bearer token for user/KYC API | Bitazza | Pending |
| 4 | `BITAZZA_API_URL` — base URL for internal trading APIs | Bitazza | Pending |
| 5 | `INTERNAL_API_KEY` — API key for internal trading APIs | Bitazza | Pending |
| 6 | IP whitelist — whitelist our Railway service IP on their API gateway | Bitazza | Pending |
| 7 | `GET /user` endpoint live and matching schema above | Bitazza | Pending |
| 8 | `GET /restrictions` endpoint live and matching schema above | Bitazza | Pending |
| 9 | `GET /internal/users/{id}/deposits[/{tx_id}]` live | Bitazza | Pending |
| 10 | `GET /internal/users/{id}/withdrawals[/{tx_id}]` live | Bitazza | Pending |
| 11 | `GET /internal/users/{id}/spot-orders[/{order_id}]` live | Bitazza | Pending |
| 12 | `GET /internal/users/{id}/futures-positions[/{position_id}]` live | Bitazza | Pending |
| 13 | `GET /internal/users/{id}/balances` live | Bitazza | Pending |
| 14 | File storage bucket + credentials (`STORAGE_*` env vars) | TBD | Pending |

---

## Notes

- All timestamps must be **ISO-8601** format in **UTC** (e.g. `2025-03-10T12:00:00Z`)
- All monetary amounts are **floats** (not strings)
- Our bot calls these APIs server-side — customers never touch them directly
- Response time budget: **5 seconds** per call (we enforce a 5s timeout on our end)
- If an endpoint is temporarily unavailable, return a standard error — our bot will tell the customer it cannot retrieve the data right now rather than crashing
