# Bitazza Exchange Integration — Go-Live Checklist (auth + KYC)

The auth + KYC integration ships **default-off** (`USE_EXCHANGE_API=false`). Staging
against Bitazza **test** users is fine as-is. The items below gate enabling exchange
mode for **real customers** (production).

See also: `CONTEXT.md` ("Bitazza integration" vocabulary) and
`docs/adr/0001-downstream-token-stays-server-side.md` (why the downstream token
stays server-side).

1. **Non-KYC account scope.** With exchange mode on, only `get_user_profile` /
   `get_kyc_status` hit real Bitazza; the other account tools still return placeholder
   data. The triage → collection → human-handoff flow catches tool *errors* and *empty*
   results, BUT `get_account_restrictions` returns a confident "no restrictions / all
   clear" default for an unknown real user — which the bot relays as fact. **Fix at
   source:** the account-restriction API is being handed to us — integrate it like KYC.
   Until then, do not enable exchange mode for real customers, or guard the non-KYC tools
   to hand off to a human. (Same latent risk for balances / deposits / withdrawals.)

2. **Session store.** The downstream token is held in an in-memory dict
   (`engine/exchange_client.py`). Replace with Redis/Postgres before running more than
   one backend instance, or session-init and KYC fetches on different instances will miss.

3. **Prod credentials + review.** Provision real-prod `WIDGET_CLIENT_ID` + HMAC secret
   (separate from staging). The auth/KYC change should get a senior-engineer review per
   org policy. Secrets live only in env / Secrets Manager — never in the repo.

4. **Logging / PII.** Ensure prod `LOG_LEVEL` is not `DEBUG` — the introspect-incomplete
   path DEBUG-logs the full profile (PII). Safe at `INFO`.

5. **Path confirmation.** Lock the `get-kyc` request URL (`get-kyc` vs the Postman's
   `get-key`) from the first real staging call. Constants live in `exchange_client.py`.

6. **Ops hygiene (optional).** The Railway environment labelled "production" is a
   personal test box — rename it so it isn't mistaken for real Bitazza production.

7. **KYC call budget.** `get-kyc` is budget-limited (Bitazza returns a 429 when over
   budget). There is no per-conversation cache, and it is called from multiple paths
   (customer-record refresh on every new ticket + per-turn account data). Cache the KYC
   result for the life of one conversation and measure the real call rate against
   Bitazza's budget in staging before trusting it under load.
