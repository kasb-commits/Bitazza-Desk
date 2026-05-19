# Changelog

All delivered changes to Bitazza-Desk, newest first.

---

## [2026-05-19] KYC Tier — Full Stack

**Commit:** `a2af4fa`

Added KYC tier (0=Unverified, 1=Basic, 2=Enhanced, 3=Full/Professional) across the entire stack.

**Mock API**
- `engine/mock_api/models.py` — `KYCInfo` model gains `kyc_tier: int = 0`
- `engine/mock_api/users.py` — all approved mock users assigned tiers (USR-000001→T1, USR-000002/003/023/024→T2, USR-000004/025→T3)

**Database**
- `db/migrations/` — `kyc_tier INT DEFAULT 0` column added to `customers` table (migration run via `migrate.js`)
- `db/conversation_store.py` — `kyc_tier` extracted from `profile["kyc"]["kyc_tier"]` and written in all 4 customer write paths (`_ensure_customer` existing/legacy/new branches + `update_customer_from_profile`); ticket-listing SELECT and result mapping also updated

**Node API**
- `dashboard/server/src/routes/tickets.js` — `c.kyc_tier AS customer_kyc_tier` in both list and single-ticket SELECTs; `kyc_tier` in both customer response mappings
- `dashboard/server/src/routes/users.js` — `kyc_tier` added to customer list SELECT

**Dashboard Frontend**
- `dashboard/src/types.ts` — `CustomerProfile.kyc_tier?: number`
- `dashboard/src/components/PropertiesPanel.tsx` — "KYC Tier" row in the Customer section of the right panel
- `dashboard/src/components/User360.tsx` — `KYC_TIER_COLORS` + `KYC_TIER_LABELS` maps; "KYC Tier" column in the customer list table; KYC tier badge in the user header; "KYC Tier" row inside the KYC Details card

---

## [2026-05-14] Agent Max Chats Ceiling

**Commit:** `25c87c9`

Raised agent `max_chats` ceiling to 100; default changed to 10.

---

## [2026-05-14] Assignment Client Module

**Commit:** `b7992c2`

Fixed missing `assignment_client` module that caused Railway boot crash.

---

## [2026-05-14] Guest (Unauthenticated) Widget Support

**Commit:** `ddbe2a3` / `57de5c0`

Added support for unauthenticated (guest) users in the chat widget — name/email capture form, guest ticket creation path in `conversation_store.py`, guest customer row in DB.
