from __future__ import annotations

from typing import Any

import httpx
from fastapi import HTTPException

from app.settings import Settings


class SupabaseRest:
    """Small server-only PostgREST client. The secret key must never reach the browser."""

    def __init__(self, http: httpx.AsyncClient, settings: Settings) -> None:
        self.http = http
        self.settings = settings

    def _headers(self) -> dict[str, str]:
        if not self.settings.supabase_configured:
            raise HTTPException(status_code=503, detail="Supabase is not configured on the API server")
        return {
            "apikey": self.settings.supabase_secret_key,
            "Content-Type": "application/json",
        }

    async def request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, str] | None = None,
        payload: dict[str, Any] | list[dict[str, Any]] | None = None,
    ) -> Any:
        response = await self.http.request(
            method,
            f"{self.settings.supabase_url}/rest/v1/{path.lstrip('/')}",
            headers={**self._headers(), "Prefer": "return=representation"},
            params=params,
            json=payload,
        )
        if response.is_error:
            if response.status_code < 500:
                try:
                    error = response.json()
                except ValueError:
                    error = None
                if isinstance(error, dict) and error.get("message") in {
                    "Enter a name for each recipient without a saved name",
                    "Enter the new customer’s name",
                    "Job changed; refresh before retrying",
                    "Only returned jobs can be edited",
                }:
                    raise HTTPException(status_code=response.status_code, detail=error["message"])
                raise HTTPException(status_code=response.status_code, detail="Supabase rejected the request")
            raise HTTPException(status_code=503, detail="Supabase is temporarily unavailable")
        if not response.content:
            return None
        return response.json()

    async def select(self, table: str, params: dict[str, str]) -> list[dict[str, Any]]:
        result = await self.request("GET", table, params=params)
        return result if isinstance(result, list) else []

    async def insert(self, table: str, payload: dict[str, Any]) -> dict[str, Any]:
        result = await self.request("POST", table, payload=payload)
        if isinstance(result, list) and result:
            return result[0]
        return result or {}

    async def update(self, table: str, params: dict[str, str], payload: dict[str, Any]) -> list[dict[str, Any]]:
        result = await self.request("PATCH", table, params=params, payload=payload)
        return result if isinstance(result, list) else []

    async def rpc(self, function: str, payload: dict[str, Any]) -> dict[str, Any]:
        result = await self.request("POST", f"rpc/{function}", payload=payload)
        if not isinstance(result, dict):
            raise HTTPException(status_code=502, detail="Unexpected response from Supabase")
        return result


async def verify_access_token(
    http: httpx.AsyncClient,
    settings: Settings,
    token: str,
) -> dict[str, Any]:
    if not settings.supabase_configured:
        raise HTTPException(status_code=503, detail="Supabase is not configured on the API server")
    response = await http.get(
        f"{settings.supabase_url}/auth/v1/user",
        headers={
            "apikey": settings.supabase_publishable_key,
            "Authorization": f"Bearer {token}",
        },
    )
    if response.status_code in (401, 403):
        raise HTTPException(status_code=401, detail="Sign in again to continue")
    if response.is_error:
        raise HTTPException(status_code=503, detail="Could not verify the sign-in session")
    return response.json()
