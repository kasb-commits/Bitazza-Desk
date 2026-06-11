"""
Mock User/KYC API router.

Endpoint:   GET /mock/user?user_id=...
            GET /mock/user?email=...
            GET /mock/user?phone=...

Exactly one query param must be supplied per request.
Auth:       Bearer token required (mock JWT — any non-empty token is accepted
            in dev; real JWT validation is wired in via the get_current_user
            dependency used by the production router).

Swap path:  Mount this router only when USE_MOCK_USER_API=true in .env.
            The production router uses the same response models, so the agent
            never needs to change.
"""
from __future__ import annotations

import os
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from engine.mock_api import users as user_store
from engine.mock_api import restrictions as restriction_store
from engine.mock_api import trading as trading_store
from engine.mock_api import balances as balance_store
from engine.mock_api.models import AccountRestrictionsResponse, UserProfile, TransactionPage, SpotTradePage, FuturesTradePage, BalancesResponse

router = APIRouter(prefix="/mock", tags=["mock-user-api"])

_bearer = HTTPBearer()


def _require_auth(credentials: HTTPAuthorizationCredentials = Depends(_bearer)) -> str:
    """
    Mock auth: accept any non-empty bearer token.
    Replace this dependency with the real JWT validator when going live.
    """
    token = credentials.credentials
    if not token:
        raise HTTPException(status_code=401, detail="Missing bearer token")
    return token


@router.get(
    "/user",
    response_model=UserProfile,
    summary="Look up a user by user_id, email, or phone (exactly one param).",
)
def get_user(
    user_id: Optional[str] = Query(default=None, description="Internal user ID"),
    email: Optional[str] = Query(default=None, description="Registered email address"),
    phone: Optional[str] = Query(default=None, description="Registered phone number"),
    _token: str = Depends(_require_auth),
) -> UserProfile:
    params = {k: v for k, v in {"user_id": user_id, "email": email, "phone": phone}.items() if v}

    if len(params) == 0:
        raise HTTPException(status_code=400, detail="Provide exactly one of: user_id, email, phone")
    if len(params) > 1:
        raise HTTPException(
            status_code=400,
            detail=f"Only one lookup param allowed; received: {', '.join(params.keys())}",
        )

    param, value = next(iter(params.items()))

    if param == "user_id":
        profile = user_store.get_by_user_id(value)
    elif param == "email":
        profile = user_store.get_by_email(value)
    else:
        profile = user_store.get_by_phone(value)

    if profile is None:
        raise HTTPException(status_code=404, detail=f"No user found for {param}='{value}'")

    return profile


@router.get(
    "/restrictions",
    response_model=AccountRestrictionsResponse,
    summary="Get active account restrictions for a user by user_id.",
)
def get_restrictions(
    user_id: str = Query(description="Internal user ID"),
    _token: str = Depends(_require_auth),
) -> AccountRestrictionsResponse:
    result = restriction_store.get_by_user_id(user_id)
    if result is None:
        # Unknown user_id — return clean no-restriction response rather than 404
        # so the agent always gets a usable response and can tell the user their
        # account has no active restrictions.
        return AccountRestrictionsResponse(
            user_id=user_id,
            has_restrictions=False,
            restrictions=[],
            trading_available=True,
            deposit_available=True,
            withdrawal_available=True,
        )
    return result


@router.get(
    "/transactions",
    response_model=TransactionPage,
    summary="Get paginated deposit/withdrawal history for a user.",
)
def get_transactions(
    user_id: str = Query(description="Internal user ID"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    _token: str = Depends(_require_auth),
) -> TransactionPage:
    if not trading_store.get_transaction_count(user_id) and user_id not in trading_store._TRANSACTIONS:
        raise HTTPException(status_code=404, detail=f"No user found for user_id='{user_id}'")
    return TransactionPage(
        user_id=user_id,
        total=trading_store.get_transaction_count(user_id),
        page=page,
        page_size=page_size,
        items=trading_store.get_transactions(user_id, page, page_size),
    )


@router.get(
    "/spot-trades",
    response_model=SpotTradePage,
    summary="Get paginated spot trade history for a user.",
)
def get_spot_trades(
    user_id: str = Query(description="Internal user ID"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    _token: str = Depends(_require_auth),
) -> SpotTradePage:
    if user_id not in trading_store._SPOT_TRADES:
        raise HTTPException(status_code=404, detail=f"No user found for user_id='{user_id}'")
    return SpotTradePage(
        user_id=user_id,
        total=trading_store.get_spot_count(user_id),
        page=page,
        page_size=page_size,
        items=trading_store.get_spot_trades(user_id, page, page_size),
    )


@router.get(
    "/futures-trades",
    response_model=FuturesTradePage,
    summary="Get paginated futures trade history for a user.",
)
def get_futures_trades(
    user_id: str = Query(description="Internal user ID"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    _token: str = Depends(_require_auth),
) -> FuturesTradePage:
    if user_id not in trading_store._FUTURES_TRADES:
        raise HTTPException(status_code=404, detail=f"No user found for user_id='{user_id}'")
    return FuturesTradePage(
        user_id=user_id,
        total=trading_store.get_futures_count(user_id),
        page=page,
        page_size=page_size,
        items=trading_store.get_futures_trades(user_id, page, page_size),
    )


@router.get(
    "/balances",
    response_model=BalancesResponse,
    summary="Get current asset balances for a user.",
)
def get_balances(
    user_id: str = Query(description="Internal user ID"),
    _token: str = Depends(_require_auth),
) -> BalancesResponse:
    return balance_store.get_balances(user_id)
