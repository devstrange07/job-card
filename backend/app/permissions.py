from __future__ import annotations

from typing import Any

from fastapi import HTTPException


ROLE_PERMISSIONS: dict[str, set[str]] = {
    "owner": {"*"},
    "admin": {"*"},
    "manager": {
        "jobs.read_store", "jobs.checkout", "jobs.return", "jobs.complete", "jobs.cancel",
        "jobs.create", "jobs.submit", "payments.record_cash", "payments.record_upi",
        "jobs.price_override", "payments.confirm_upi", "payments.reverse", "billing.record", "billing.approve_discrepancy",
        "catalog.read", "catalog.manage", "staff.read", "staff.manage", "audit.read",
    },
    "cashier": {
        "jobs.read_store", "jobs.checkout", "jobs.return", "jobs.complete",
        "payments.record_cash", "payments.record_upi", "payments.confirm_upi", "billing.record",
        "catalog.read", "staff.read",
    },
    "salesperson": {
        "jobs.create", "jobs.read_own", "jobs.edit_own", "jobs.submit",
        "payments.record_cash", "payments.record_upi", "catalog.read", "staff.read",
    },
    "promoter": {"jobs.read_assigned", "catalog.read"},
}


def permissions_for(membership: dict[str, Any]) -> set[str]:
    permissions = set(ROLE_PERMISSIONS.get(membership.get("role", ""), set()))
    permissions.update(membership.get("allow_permissions") or [])
    permissions.difference_update(membership.get("deny_permissions") or [])
    return permissions


def require_permission(membership: dict[str, Any], permission: str) -> None:
    if membership.get("status") != "active":
        raise HTTPException(status_code=403, detail="This staff account is not active for the store")
    if permission in (membership.get("deny_permissions") or []):
        raise HTTPException(status_code=403, detail="You do not have permission to perform this action")
    granted = permissions_for(membership)
    if "*" not in granted and permission not in granted:
        raise HTTPException(status_code=403, detail="You do not have permission to perform this action")
