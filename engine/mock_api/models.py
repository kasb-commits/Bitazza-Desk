"""
Pydantic models for the User Profile / KYC API.

These models define the canonical internal schema.
When connecting to the real API, map its response into these models —
the rest of the codebase never needs to change.
"""
from __future__ import annotations

from enum import Enum
from typing import Optional
from pydantic import BaseModel


class KYCStatus(str, Enum):
    approved = "approved"
    rejected = "rejected"
    pending_information = "pending_information"
    pending_review = "pending_review"
    not_started = "not_started"
    suspended = "suspended"
    expired = "expired"


class UserTier(str, Enum):
    regular = "regular"
    vip = "VIP"
    ea = "EA"
    high_net_worth = "High net worth"


class KYCInfo(BaseModel):
    status: KYCStatus
    kyc_tier: int = 0                        # 0=unverified, 1=basic, 2=enhanced, 3=full/professional
    rejection_reason: Optional[str] = None   # only populated when status == rejected
    reviewed_at: Optional[str] = None        # ISO-8601 datetime string


class UserProfile(BaseModel):
    user_id: str
    first_name: str
    last_name: str
    email: str
    phone: str
    tier: UserTier
    kyc: KYCInfo


class ErrorResponse(BaseModel):
    error: str
    detail: Optional[str] = None


# ── Account Restriction models ────────────────────────────────────────────────

class RestrictionType(str, Enum):
    deposit_block    = "deposit_block"
    withdrawal_block = "withdrawal_block"
    trading_block    = "trading_block"
    full_freeze      = "full_freeze"
    login_block      = "login_block"


class RestrictionStatus(str, Enum):
    active       = "active"
    under_review = "under_review"
    lifted       = "lifted"


class AccountRestriction(BaseModel):
    restriction_id: str
    type: RestrictionType
    status: RestrictionStatus
    reason: str                              # human-readable; never expose regulatory detail
    applied_at: str                          # ISO-8601
    expected_lift_at: Optional[str] = None  # None = indefinite
    can_self_resolve: bool = False
    resolution_steps: Optional[str] = None  # populated when can_self_resolve=True


class AccountRestrictionsResponse(BaseModel):
    user_id: str
    has_restrictions: bool
    restrictions: list[AccountRestriction]
    trading_available: bool
    trading_block_reason: Optional[str] = None


# ── Transaction & Trade history models ───────────────────────────────────────

class TransactionType(str, Enum):
    deposit  = "deposit"
    withdrawal = "withdrawal"

class TransactionStatus(str, Enum):
    completed = "completed"
    pending   = "pending"
    failed    = "failed"
    cancelled = "cancelled"

class Transaction(BaseModel):
    transaction_id: str
    type: TransactionType
    status: TransactionStatus
    currency: str
    amount: float
    fee: float
    network: Optional[str] = None          # e.g. "BTC", "TRC20", "PromptPay"
    tx_hash: Optional[str] = None          # on-chain hash for crypto
    bank_ref: Optional[str] = None         # for fiat transfers
    created_at: str                         # ISO-8601
    completed_at: Optional[str] = None

class TransactionPage(BaseModel):
    user_id: str
    total: int
    page: int
    page_size: int
    items: list[Transaction]


class SpotSide(str, Enum):
    buy  = "buy"
    sell = "sell"

class SpotOrderType(str, Enum):
    limit  = "limit"
    market = "market"

class SpotOrderStatus(str, Enum):
    filled          = "filled"
    partially_filled = "partially_filled"
    cancelled       = "cancelled"
    open            = "open"

class SpotTrade(BaseModel):
    order_id: str
    symbol: str          # e.g. "BTC/THB"
    side: SpotSide
    order_type: SpotOrderType
    status: SpotOrderStatus
    price: float
    quantity: float
    filled_qty: float
    fee: float
    fee_currency: str
    created_at: str
    updated_at: str

class SpotTradePage(BaseModel):
    user_id: str
    total: int
    page: int
    page_size: int
    items: list[SpotTrade]


class FuturesSide(str, Enum):
    long  = "long"
    short = "short"

class FuturesStatus(str, Enum):
    open   = "open"
    closed = "closed"
    liquidated = "liquidated"

class FuturesTrade(BaseModel):
    position_id: str
    symbol: str           # e.g. "BTCUSDT-PERP"
    side: FuturesSide
    status: FuturesStatus
    leverage: int
    entry_price: float
    exit_price: Optional[float] = None
    quantity: float
    pnl: Optional[float] = None           # realized PnL, None if still open
    fee: float
    liquidation_price: Optional[float] = None
    created_at: str
    closed_at: Optional[str] = None

class FuturesTradePage(BaseModel):
    user_id: str
    total: int
    page: int
    page_size: int
    items: list[FuturesTrade]


# ── Balance models ────────────────────────────────────────────────────────────

class Balance(BaseModel):
    currency: str
    available: float
    locked: float = 0.0       # in open orders / locked

class BalancesResponse(BaseModel):
    user_id: str
    balances: list[Balance]
