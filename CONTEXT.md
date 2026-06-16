# CS Bot — Context Glossary

The shared language of the AI customer-support agent: ticket lifecycle, prompt
assembly, and conversation concepts. This is a glossary, not a spec — definitions
only, no implementation detail.

## Ticket lifecycle

**Resolved**:
A ticket state meaning the issue is believed answered. It is NOT terminal — a
resolved ticket auto-closes after 24h of no activity.
_Avoid_: Closed, Done (Resolved and Closed are distinct states).

**Closed**:
The terminal ticket state. Reached from Resolved (24h idle), Snoozed (snooze
expiry), or directly. Once closed, the ticket is done.
_Avoid_: Resolved (not interchangeable).

**Guest Session**:
A chat from an unauthenticated visitor — there is no `user_id`, so no account
data and no account tools are available.
_Avoid_: Anonymous user, logged-out user.

## Prompt assembly

**Module**:
A named, language-keyed block of system-prompt text (CORE, LISTING, ACCOUNT,
GUEST, CATEGORY, EMAIL) selected and concatenated at runtime to build one system
prompt for a conversation.
_Avoid_: Overlay (legacy term for the per-category blocks; prefer "module").

**LISTING module**:
Prompt rules for how to enumerate requirements, fees, steps, and tier
comparisons (include every item; tiers are cumulative). It is about list
*formatting discipline* — NOT about crypto asset/coin listings.
_Avoid_: using "listing" to mean asset listing in this context.

**Pills**:
The 2–4 quick-reply buttons offered to the customer after a bot turn
(`quick_replies`). Certain phrasings are "banned pills" the model must never
generate (e.g. "Talk to agent", "Something else").
_Avoid_: quick replies, chips, buttons.

## Conversation phases

**Triage (Phase 1)**:
The first bot turn for an account category — ask one focused triage question
with specific options, before collecting details or using account data.

**Collection (Phase 2)**:
Mid-conversation turns gathering the details needed to act, after triage and
before account data is available.

**Resolution (Phase 3)**:
The turn where workflow-injected account data is present (marked by
`--- PHASE 3 ACTIVE` in context) — stop asking questions and use the data.

## Bitazza integration (auth + KYC)

**Exchange**:
The Bitazza Exchange backend that owns customer identity and KYC and issues/
validates the session tokens below. The external system we integrate with.
_Avoid_: Freedom (a separate platform), the gateway, the API.

**Bootstrap token**:
A single-use token the Exchange issues to begin an authenticated widget session;
the host app hands it to our widget. Short-lived.
_Avoid_: wstb, init token, bootstrap (unqualified).

**Downstream token**:
The token our backend receives in exchange for a Bootstrap token, used to read
the customer's data from the Exchange. Never leaves the server.
_Avoid_: wstd, access token, bearer token.

**Widget session token**:
The token our backend issues to the widget after a successful exchange. It
identifies the authenticated customer for the rest of the conversation.
_Avoid_: JWT, auth token (when precision matters).

**Widget session**:
An authenticated widget conversation backed by a real Exchange customer (has a
user_id). Contrast Guest Session (no user_id, no account data).
_Avoid_: session (unqualified — say Widget session or Guest Session).
