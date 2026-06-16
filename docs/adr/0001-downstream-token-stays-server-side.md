# Downstream token stays server-side; the widget gets our own session token

The Bitazza Exchange issues a **downstream token** that grants read access to a
customer's identity and KYC. Our widget runs in the customer's browser / mobile
app. We decided that our backend exchanges the single-use **bootstrap token** for
the downstream token, **keeps the downstream token server-side only**, and hands
the widget a separate **widget session token** (our own short-lived JWT carrying
just the user_id). The widget never receives the downstream token.

Why: the powerful Exchange credential never touches the customer's device, so it
can't be lifted from browser storage, devtools, or a compromised client. Our
backend mediates every Exchange call and controls scope and expiry independently.
The rejected alternative — forwarding the Exchange downstream token to the client
— is simpler but exposes that credential in the browser.

## Consequences

The backend must hold per-customer session state (the downstream token) between
the session-init call and later KYC calls. Staging uses an in-memory store
(single instance only); a shared store (Redis/Postgres) is required before
multi-instance production.
