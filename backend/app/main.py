from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
import hmac
import re
from typing import Any, Literal
from uuid import UUID, uuid4

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware

from app.permissions import permissions_for, require_permission
from app.schemas import (
    ChargeCatalogInput,
    ConfirmUpiInput,
    CreateJobInput,
    CustomerLookupInput,
    AcceptStaffInvitationInput,
    InitializeStoreInput,
    InviteStaffInput,
    InvoiceInput,
    PaymentInput,
    ProductInput,
    PhoneLookupInput,
    JobAttributionInput,
    RewardRecipientInput,
    TransitionInput,
    UpdateJobInput,
    UpdateStaffInput,
)
from app.settings import Settings
from app.supabase_client import SupabaseRest, verify_access_token


settings = Settings.from_env()


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.settings = settings
    app.state.http = httpx.AsyncClient(timeout=httpx.Timeout(12.0, connect=5.0))
    yield
    await app.state.http.aclose()


app = FastAPI(title="Job Card API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_origins),
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Idempotency-Key"],
)


@app.middleware("http")
async def add_no_store_header(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


async def current_user(
    request: Request,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Sign in to continue")
    token = authorization.split(" ", 1)[1].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Sign in to continue")
    return await verify_access_token(request.app.state.http, request.app.state.settings, token)


def rest(request: Request) -> SupabaseRest:
    return SupabaseRest(request.app.state.http, request.app.state.settings)


async def validate_catalog_prices(
    db: SupabaseRest,
    store_id: UUID,
    lines: list[Any],
    membership: dict[str, Any],
) -> None:
    product_ids = sorted({str(line.product_id) for line in lines if line.product_id is not None})
    if not product_ids:
        return
    products = await db.select(
        "products",
        {
            "select": "id,default_unit_price_minor,is_active",
            "store_id": f"eq.{store_id}",
            "id": f"in.({','.join(product_ids)})",
        },
    )
    by_id = {item["id"]: item for item in products}
    if any(product_id not in by_id or not by_id[product_id]["is_active"] for product_id in product_ids):
        raise HTTPException(status_code=422, detail="A selected catalog product is no longer available")
    if "jobs.price_override" not in permissions_for(membership) and "*" not in permissions_for(membership):
        if any(line.unit_price_minor != int(by_id[str(line.product_id)]["default_unit_price_minor"]) for line in lines if line.product_id is not None):
            raise HTTPException(status_code=403, detail="You do not have permission to override catalog prices")


async def membership_for(
    db: SupabaseRest,
    store_id: UUID,
    user_id: str,
) -> dict[str, Any]:
    memberships = await db.select(
        "store_memberships",
        {
            "select": "store_id,user_id,display_name,role,status,allow_permissions,deny_permissions",
            "store_id": f"eq.{store_id}",
            "user_id": f"eq.{user_id}",
            "limit": "1",
        },
    )
    if not memberships:
        raise HTTPException(status_code=403, detail="You are not a member of this store")
    membership = memberships[0]
    if membership.get("status") != "active":
        raise HTTPException(status_code=403, detail="This staff account is not active for the store")
    return membership


async def authorized_membership(
    request: Request,
    store_id: UUID,
    user: dict[str, Any],
) -> tuple[SupabaseRest, dict[str, Any]]:
    db = rest(request)
    membership = await membership_for(db, store_id, str(user["id"]))
    return db, membership


def require_staff_role_scope(actor: dict[str, Any], role: str) -> None:
    actor_role = actor.get("role")
    if role == "owner":
        raise HTTPException(status_code=403, detail="Owner access cannot be assigned from Team Access")
    if actor_role == "owner":
        return
    if actor_role == "admin" and role == "manager":
        return
    if actor_role == "manager" and role in {"salesperson", "cashier", "promoter"}:
        return
    raise HTTPException(status_code=403, detail="Your role cannot assign this staff role")


async def auth_admin_invite(request: Request, email: str, redirect_to: str, display_name: str) -> None:
    settings: Settings = request.app.state.settings
    if not settings.frontend_url:
        raise HTTPException(status_code=503, detail="FRONTEND_URL is not configured on the API server")
    response = await request.app.state.http.post(
        f"{settings.supabase_url}/auth/v1/invite",
        params={"redirect_to": redirect_to},
        headers={
            "apikey": settings.supabase_secret_key,
            "Authorization": f"Bearer {settings.supabase_secret_key}",
            "Content-Type": "application/json",
        },
        json={"email": email, "data": {"display_name": display_name}},
    )
    if not response.is_error:
        return
    try:
        payload = response.json()
    except ValueError:
        payload = {}
    detail = str(payload.get("msg") or payload.get("message") or payload.get("error_description") or "")
    normalized = detail.lower()
    if "already" in normalized and ("user" in normalized or "registered" in normalized):
        raise HTTPException(status_code=409, detail="This email already has a Supabase account. Ask the employee to sign in before adding store access.")
    if response.status_code == 429:
        raise HTTPException(status_code=429, detail="Supabase email rate limit reached. Wait before sending another invite.")
    raise HTTPException(status_code=502, detail="Supabase could not send the invitation email")


async def auth_existing_account_invite(request: Request, email: str, redirect_to: str) -> None:
    settings: Settings = request.app.state.settings
    response = await request.app.state.http.post(
        f"{settings.supabase_url}/auth/v1/otp",
        params={"redirect_to": redirect_to},
        headers={"apikey": settings.supabase_publishable_key, "Content-Type": "application/json"},
        json={"email": email, "create_user": False},
    )
    if not response.is_error:
        return
    if response.status_code == 429:
        raise HTTPException(status_code=429, detail="Supabase email rate limit reached. Wait before sending another invite.")
    raise HTTPException(status_code=502, detail="Supabase could not send the sign-in link for this existing account")


async def record_staff_event(
    db: SupabaseRest,
    *,
    store_id: UUID,
    actor_id: str,
    action: str,
    subject_email: str | None = None,
    subject_user_id: str | None = None,
    details: dict[str, Any] | None = None,
) -> None:
    await db.insert("staff_access_events", {
        "store_id": str(store_id),
        "actor_user_id": actor_id,
        "subject_user_id": subject_user_id,
        "subject_email": subject_email,
        "action": action,
        "details": details or {},
    })


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "job-card-api"}


@app.get("/api/session")
async def session(request: Request, user: dict[str, Any] = Depends(current_user)):
    db = rest(request)
    memberships = await db.select(
        "store_memberships",
        {
            "select": "store_id,display_name,role,status,allow_permissions,deny_permissions,store:stores!inner(id,name,currency_code,timezone,is_active)",
            "user_id": f"eq.{user['id']}",
            "status": "eq.active",
            "store.is_active": "eq.true",
        },
    )
    bootstrap_email = request.app.state.settings.bootstrap_owner_email
    can_initialize_store = bool(
        not memberships and bootstrap_email
        and str(user.get("email") or "").lower() == bootstrap_email
        and not await db.select("stores", {"select": "id", "limit": "1"})
    )
    return {
        "user": {"id": user["id"], "email": user.get("email")},
        "can_initialize_store": can_initialize_store,
        "stores": [
            {**item, "permissions": sorted(permissions_for(item))}
            for item in memberships
        ],
    }


@app.post("/api/setup/store")
async def initialize_store(
    body: InitializeStoreInput,
    request: Request,
    user: dict[str, Any] = Depends(current_user),
):
    settings: Settings = request.app.state.settings
    email = str(user.get("email", "")).lower()
    if not settings.bootstrap_owner_email or email != settings.bootstrap_owner_email:
        raise HTTPException(status_code=403, detail="This account is not authorized to initialize the store")
    db = rest(request)
    existing = await db.select("stores", {"select": "id", "limit": "1"})
    if existing:
        raise HTTPException(status_code=409, detail="Store setup has already been completed")
    return await db.rpc(
        "initialize_store",
        {
            "p_owner_user_id": user["id"],
            "p_store_name": body.store_name,
            "p_currency_code": body.currency_code,
            "p_timezone": body.timezone,
            "p_owner_display_name": email.split("@")[0][:120],
        },
    )


@app.get("/api/staff")
async def list_staff(
    store_id: UUID,
    request: Request,
    user: dict[str, Any] = Depends(current_user),
):
    db, membership = await authorized_membership(request, store_id, user)
    require_permission(membership, "staff.read")
    return await db.select(
        "store_memberships",
        {
            "select": "user_id,email,display_name,role,status",
            "store_id": f"eq.{store_id}",
            "order": "created_at.asc",
        },
    )


@app.get("/api/staff/invitations")
async def list_staff_invitations(
    store_id: UUID,
    request: Request,
    user: dict[str, Any] = Depends(current_user),
):
    db, membership = await authorized_membership(request, store_id, user)
    require_permission(membership, "staff.manage")
    invitations = await db.select(
        "staff_invitations",
        {
            "select": "id,email,display_name,role,status,expires_at,created_at",
            "store_id": f"eq.{store_id}",
            "status": "in.(pending,failed,expired)",
            "order": "created_at.desc",
        },
    )
    now = datetime.now(timezone.utc)
    for invitation in invitations:
        if invitation["status"] == "pending" and datetime.fromisoformat(invitation["expires_at"].replace("Z", "+00:00")) <= now:
            invitation["status"] = "expired"
            await db.update("staff_invitations", {"id": f"eq.{invitation['id']}"}, {"status": "expired", "updated_at": now.isoformat()})
    return invitations


@app.post("/api/staff/invitations", status_code=201)
async def invite_staff(
    body: InviteStaffInput,
    request: Request,
    user: dict[str, Any] = Depends(current_user),
):
    db, membership = await authorized_membership(request, body.store_id, user)
    require_permission(membership, "staff.manage")
    require_staff_role_scope(membership, body.role)
    email = body.email.strip().lower()
    if not re.fullmatch(r"[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}", email):
        raise HTTPException(status_code=422, detail="Enter a valid email address")
    display_name = body.display_name.strip()
    if not display_name:
        raise HTTPException(status_code=422, detail="Enter the employee's name")

    existing_member = await db.select(
        "store_memberships",
        {"select": "user_id", "store_id": f"eq.{body.store_id}", "email": f"eq.{email}", "limit": "1"},
    )
    if existing_member:
        raise HTTPException(status_code=409, detail="This employee already belongs to the store")
    pending = await db.select(
        "staff_invitations",
        {"select": "id,expires_at", "store_id": f"eq.{body.store_id}", "email": f"eq.{email}", "status": "eq.pending", "limit": "1"},
    )
    if pending:
        expiry = datetime.fromisoformat(pending[0]["expires_at"].replace("Z", "+00:00"))
        if expiry > datetime.now(timezone.utc):
            raise HTTPException(status_code=409, detail="A pending invitation already exists for this email")
        await db.update("staff_invitations", {"id": f"eq.{pending[0]['id']}"}, {"status": "expired", "updated_at": datetime.now(timezone.utc).isoformat()})

    invitation = await db.insert("staff_invitations", {
        "store_id": str(body.store_id),
        "email": email,
        "display_name": display_name,
        "role": body.role,
        "status": "pending",
        "invited_by": user["id"],
    })
    invitation_id = invitation["id"]
    redirect_to = f"{request.app.state.settings.frontend_url}/auth/accept-invitation?invitation_id={invitation_id}"
    try:
        await auth_admin_invite(request, email, redirect_to, display_name)
    except HTTPException as error:
        if error.status_code == 409:
            try:
                await auth_existing_account_invite(request, email, redirect_to)
            except HTTPException:
                await db.update("staff_invitations", {"id": f"eq.{invitation_id}"}, {"status": "failed", "updated_at": datetime.now(timezone.utc).isoformat()})
                raise
        else:
            await db.update("staff_invitations", {"id": f"eq.{invitation_id}"}, {"status": "failed", "updated_at": datetime.now(timezone.utc).isoformat()})
            raise error

    await record_staff_event(db, store_id=body.store_id, actor_id=user["id"], action="invited", subject_email=email, details={"role": body.role})
    return invitation


@app.post("/api/staff/invitations/{invitation_id}/resend")
async def resend_staff_invitation(
    invitation_id: UUID,
    store_id: UUID,
    request: Request,
    user: dict[str, Any] = Depends(current_user),
):
    db, membership = await authorized_membership(request, store_id, user)
    require_permission(membership, "staff.manage")
    invitations = await db.select(
        "staff_invitations",
        {"select": "id,email,display_name,role,status,expires_at", "id": f"eq.{invitation_id}", "store_id": f"eq.{store_id}", "limit": "1"},
    )
    if not invitations or invitations[0]["status"] not in {"pending", "failed", "expired"}:
        raise HTTPException(status_code=404, detail="Pending invitation not found")
    invitation = invitations[0]
    require_staff_role_scope(membership, invitation["role"])
    redirect_to = f"{request.app.state.settings.frontend_url}/auth/accept-invitation?invitation_id={invitation_id}"
    try:
        await auth_admin_invite(request, invitation["email"], redirect_to, invitation["display_name"])
    except HTTPException as error:
        if error.status_code != 409:
            raise
        await auth_existing_account_invite(request, invitation["email"], redirect_to)
    await db.update("staff_invitations", {"id": f"eq.{invitation_id}"}, {
        "status": "pending",
        "expires_at": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    })
    await record_staff_event(db, store_id=store_id, actor_id=user["id"], action="invite_resent", subject_email=invitation["email"], details={"role": invitation["role"]})
    return {"id": str(invitation_id), "status": "pending"}


@app.post("/api/staff/invitations/{invitation_id}/cancel")
async def cancel_staff_invitation(
    invitation_id: UUID,
    store_id: UUID,
    request: Request,
    user: dict[str, Any] = Depends(current_user),
):
    db, membership = await authorized_membership(request, store_id, user)
    require_permission(membership, "staff.manage")
    invitations = await db.select(
        "staff_invitations",
        {"select": "id,email,role,status", "id": f"eq.{invitation_id}", "store_id": f"eq.{store_id}", "limit": "1"},
    )
    if not invitations or invitations[0]["status"] not in {"pending", "failed", "expired"}:
        raise HTTPException(status_code=404, detail="Pending invitation not found")
    invitation = invitations[0]
    require_staff_role_scope(membership, invitation["role"])
    await db.update("staff_invitations", {"id": f"eq.{invitation_id}"}, {"status": "revoked", "updated_at": datetime.now(timezone.utc).isoformat()})
    await record_staff_event(db, store_id=store_id, actor_id=user["id"], action="invite_cancelled", subject_email=invitation["email"], details={"role": invitation["role"]})
    return {"id": str(invitation_id), "status": "revoked"}


@app.post("/api/staff/invitations/accept")
async def accept_staff_invitation(
    body: AcceptStaffInvitationInput,
    request: Request,
    user: dict[str, Any] = Depends(current_user),
):
    verified_email = str(user.get("email") or "").strip().lower()
    if not verified_email or not (user.get("email_confirmed_at") or user.get("confirmed_at")):
        raise HTTPException(status_code=403, detail="Confirm the invited email address before accepting")
    db = rest(request)
    try:
        return await db.rpc("accept_staff_invitation", {
            "p_invitation_id": str(body.invitation_id),
            "p_user_id": user["id"],
            "p_verified_email": verified_email,
        })
    except HTTPException as error:
        if error.status_code == 409:
            raise HTTPException(status_code=409, detail="This account already has a membership in the store") from error
        raise


@app.patch("/api/staff/{staff_user_id}")
async def update_staff(
    staff_user_id: UUID,
    body: UpdateStaffInput,
    request: Request,
    user: dict[str, Any] = Depends(current_user),
):
    if body.role is None and body.status is None:
        raise HTTPException(status_code=422, detail="Choose a role or membership status to update")
    db, membership = await authorized_membership(request, body.store_id, user)
    require_permission(membership, "staff.manage")
    if str(staff_user_id) == str(user["id"]):
        raise HTTPException(status_code=403, detail="You cannot change your own store access")
    rows = await db.select(
        "store_memberships",
        {"select": "user_id,email,display_name,role,status", "store_id": f"eq.{body.store_id}", "user_id": f"eq.{staff_user_id}", "limit": "1"},
    )
    if not rows:
        raise HTTPException(status_code=404, detail="Staff member not found")
    target = rows[0]
    if target["role"] == "owner":
        raise HTTPException(status_code=403, detail="Owner access is protected")
    require_staff_role_scope(membership, target["role"])
    updates: dict[str, Any] = {"updated_at": datetime.now(timezone.utc).isoformat()}
    if body.role is not None:
        require_staff_role_scope(membership, body.role)
        updates["role"] = body.role
    if body.status is not None:
        updates["status"] = body.status
    updated = await db.update("store_memberships", {"store_id": f"eq.{body.store_id}", "user_id": f"eq.{staff_user_id}"}, updates)
    if not updated:
        raise HTTPException(status_code=404, detail="Staff member not found")
    action = "role_changed" if body.role is not None else ("suspended" if body.status == "suspended" else "reactivated")
    await record_staff_event(
        db,
        store_id=body.store_id,
        actor_id=user["id"],
        action=action,
        subject_user_id=str(staff_user_id),
        subject_email=target.get("email"),
        details={"before_role": target["role"], "after_role": updated[0]["role"], "status": updated[0]["status"]},
    )
    return updated[0]


@app.get("/api/catalog")
async def get_catalog(
    store_id: UUID,
    request: Request,
    user: dict[str, Any] = Depends(current_user),
):
    db, membership = await authorized_membership(request, store_id, user)
    require_permission(membership, "catalog.read")
    products = await db.select(
        "products",
        {"select": "id,name,brand,sku,default_unit_price_minor", "store_id": f"eq.{store_id}", "is_active": "eq.true", "order": "name"},
    )
    charges = await db.select(
        "charge_catalog",
        {"select": "id,name,description,default_amount_minor,billing_note", "store_id": f"eq.{store_id}", "is_active": "eq.true", "order": "sort_order,name"},
    )
    return {"products": products, "charges": charges}


@app.post("/api/catalog/products")
async def create_product(
    body: ProductInput,
    request: Request,
    user: dict[str, Any] = Depends(current_user),
):
    db, membership = await authorized_membership(request, body.store_id, user)
    require_permission(membership, "catalog.manage")
    payload = body.model_dump(mode="json", exclude={"store_id"})
    payload["store_id"] = str(body.store_id)
    return await db.insert("products", payload)


@app.post("/api/catalog/charges")
async def create_charge(
    body: ChargeCatalogInput,
    request: Request,
    user: dict[str, Any] = Depends(current_user),
):
    db, membership = await authorized_membership(request, body.store_id, user)
    require_permission(membership, "catalog.manage")
    payload = body.model_dump(mode="json", exclude={"store_id"})
    payload["store_id"] = str(body.store_id)
    return await db.insert("charge_catalog", payload)


async def history_rows(
    db: SupabaseRest,
    store_id: UUID,
    customer_id: str,
    status: str,
    limit: int,
    offset: int = 0,
) -> list[dict[str, Any]]:
    return await db.select("jobs", {
        "select": "id,job_number,created_at,status,currency_code,quoted_total_minor,final_billed_total_minor,staff_note,created_by,job_line_items(label_snapshot)",
        "store_id": f"eq.{store_id}",
        "customer_id": f"eq.{customer_id}",
        "status": status,
        "order": "created_at.desc,id.desc",
        "job_line_items.order": "sort_order.asc",
        "job_line_items.limit": "1",
        "limit": str(limit),
        "offset": str(offset),
    })


def strip_history_notes(row: dict[str, Any], membership: dict[str, Any], user_id: str) -> None:
    own_job = str(row["created_by"]) == user_id
    if not has_permission(membership, "jobs.read_store") and not (own_job and has_permission(membership, "jobs.read_own")):
        row.pop("staff_note", None)
    row.pop("created_by", None)


def has_permission(membership: dict[str, Any], permission: str) -> bool:
    if permission in (membership.get("deny_permissions") or []):
        return False
    return bool({permission, "*"} & permissions_for(membership))


async def customer_by_phone(db: SupabaseRest, store_id: UUID, phone: str) -> dict[str, Any] | None:
    customers = await db.select("customers", {
        "select": "id,display_name",
        "store_id": f"eq.{store_id}",
        "phone_e164": f"eq.{phone}",
        "limit": "1",
    })
    return customers[0] if customers else None


@app.post("/api/customers/recipient-lookup")
async def lookup_recipient(
    body: PhoneLookupInput,
    request: Request,
    user: dict[str, Any] = Depends(current_user),
):
    db, membership = await authorized_membership(request, body.store_id, user)
    if not any(has_permission(membership, permission) for permission in ("jobs.create", "jobs.edit_own", "jobs.edit_store")):
        raise HTTPException(status_code=403, detail="You do not have permission to look up recipients")
    customer = await customer_by_phone(db, body.store_id, body.phone)
    name = (customer.get("display_name") or "").strip() if customer else ""
    return {"name": name or None}


@app.post("/api/customers/lookup")
async def lookup_customer(
    body: CustomerLookupInput,
    request: Request,
    user: dict[str, Any] = Depends(current_user),
):
    db, membership = await authorized_membership(request, body.store_id, user)
    can_read_history = has_permission(membership, "customers.read_history")
    if not can_read_history:
        require_permission(membership, "jobs.create")
    customer = await customer_by_phone(db, body.store_id, body.phone)
    if not customer:
        return {"customer": None, "visits": [], "active_job": None, "next_offset": None}

    if not can_read_history:
        return {"customer": customer, "visits": [], "active_job": None, "next_offset": None, "history_available": False}
    page_size = 3 if body.offset == 0 else 12
    visits = await history_rows(db, body.store_id, customer["id"], "eq.completed", page_size + 1, body.offset)
    active = []
    if body.offset == 0:
        active = await history_rows(db, body.store_id, customer["id"], "in.(ready,checkout,returned)", 1)
    for row in visits + active:
        strip_history_notes(row, membership, user["id"])
    return {
        "customer": customer,
        "visits": visits[:page_size],
        "active_job": active[0] if active else None,
        "next_offset": body.offset + page_size if len(visits) > page_size else None,
    }


@app.get("/api/customers/{customer_id}/visits/{job_id}")
async def read_customer_visit(
    store_id: UUID,
    customer_id: UUID,
    job_id: UUID,
    request: Request,
    user: dict[str, Any] = Depends(current_user),
):
    db, membership = await authorized_membership(request, store_id, user)
    require_permission(membership, "customers.read_history")
    rows = await db.select("jobs", {
        "select": (
            "id,job_number,created_at,status,currency_code,quoted_total_minor,final_billed_total_minor,"
            "staff_note,created_by,job_line_items(id,label_snapshot,sku_snapshot,quantity,unit_price_minor),"
            "job_charge_items(id,name_snapshot,quantity,unit_amount_minor)"
        ),
        "store_id": f"eq.{store_id}",
        "customer_id": f"eq.{customer_id}",
        "id": f"eq.{job_id}",
        "status": "in.(ready,checkout,returned,completed)",
        "job_line_items.order": "sort_order.asc",
        "job_charge_items.order": "sort_order.asc",
        "limit": "1",
    })
    if not rows:
        raise HTTPException(status_code=404, detail="Visit not found")
    strip_history_notes(rows[0], membership, user["id"])
    return rows[0]


@app.get("/api/jobs")
async def list_jobs(
    store_id: UUID,
    request: Request,
    status: str | None = Query(default=None),
    user: dict[str, Any] = Depends(current_user),
):
    db, membership = await authorized_membership(request, store_id, user)
    permissions = permissions_for(membership)
    if "*" not in permissions and not ({"jobs.read_store", "jobs.read_own", "jobs.read_assigned"} & permissions):
        raise HTTPException(status_code=403, detail="You do not have permission to view jobs")
    can_edit_store = has_permission(membership, "jobs.edit_store")
    can_edit_own = has_permission(membership, "jobs.edit_own")
    select = "*,job_line_items(*),job_charge_items(*),payments(*),job_contributors(*)"
    if can_edit_store or can_edit_own:
        select += ",job_reward_recipients(role,phone_e164,display_name_snapshot)"
    params = {
        "select": select,
        "store_id": f"eq.{store_id}",
        "order": "created_at.desc",
        "limit": "100",
    }
    if status:
        params["status"] = f"eq.{status}"
    if "jobs.read_store" not in permissions and "*" not in permissions:
        params["created_by"] = f"eq.{user['id']}"
    jobs = await db.select("jobs", params)
    if can_edit_own and not can_edit_store:
        for job in jobs:
            if str(job["created_by"]) != user["id"]:
                job.pop("job_reward_recipients", None)
    return [job_response(job, membership, db) for job in jobs]


def recipient_key(db: SupabaseRest, job_id: str, role: str, phone: str) -> str:
    message = f"job-recipient:{job_id}:{role}:{phone}".encode()
    return hmac.digest(db.settings.supabase_secret_key.encode(), message, "sha256").hex()


def job_response(job: dict[str, Any], membership: dict[str, Any], db: SupabaseRest) -> dict[str, Any]:
    if has_permission(membership, "customers.read_phone"):
        return job
    result = {key: value for key, value in job.items() if key != "customer_phone_snapshot"}
    if "job_reward_recipients" in result:
        result["job_reward_recipients"] = [
            {
                "role": item["role"],
                "display_name_snapshot": item["display_name_snapshot"],
                "saved_key": recipient_key(db, str(job["id"]), item["role"], item["phone_e164"]),
            }
            for item in result["job_reward_recipients"]
        ]
    return result


@app.post("/api/jobs")
async def create_job(
    body: CreateJobInput,
    request: Request,
    user: dict[str, Any] = Depends(current_user),
):
    db, membership = await authorized_membership(request, body.store_id, user)
    require_permission(membership, "jobs.create")
    require_permission(membership, "jobs.submit")
    previous = await submitted_job(db, body, user["id"])
    if previous:
        return job_response(previous, membership, db)
    if any(item.saved_key for item in body.reward_recipients):
        raise HTTPException(status_code=422, detail="Enter a phone number for each new recipient")
    validate_recipients(body, body.customer_phone)
    await validate_catalog_prices(db, body.store_id, body.lines, membership)
    contributor_ids = sorted({str(item.user_id) for item in body.contributors})
    contributor_snapshots: list[dict[str, str]] = []
    if contributor_ids:
        active_members = await db.select(
            "store_memberships",
            {
                "select": "user_id,display_name,role,status",
                "store_id": f"eq.{body.store_id}",
                "user_id": f"in.({','.join(contributor_ids)})",
                "status": "eq.active",
            },
        )
        by_id = {item["user_id"]: item for item in active_members}
        if any(user_id not in by_id for user_id in contributor_ids):
            raise HTTPException(status_code=422, detail="Choose active staff from this store")
        contributor_snapshots = [
            {
                "user_id": str(item.user_id),
                "display_name_snapshot": by_id[str(item.user_id)].get("display_name") or by_id[str(item.user_id)]["role"],
                "contribution": item.contribution,
            }
            for item in body.contributors
        ]
    job = await db.rpc(
        "submit_job_card",
        {
            "p_store_id": str(body.store_id),
            "p_submission_key": str(body.submission_key or uuid4()),
            "p_job_id": None,
            "p_expected_version": None,
            "p_customer_phone": body.customer_phone,
            "p_customer_name": body.customer_name,
            "p_actor_user_id": user["id"],
            "p_lines": [line.model_dump(mode="json") for line in body.lines],
            "p_charges": [charge.model_dump(mode="json") for charge in body.charges],
            "p_contributors": contributor_snapshots,
            "p_staff_note": body.staff_note,
            **recipient_payload(body),
        },
    )
    return job_response(job, membership, db)


async def submitted_job(db: SupabaseRest, body: CreateJobInput | UpdateJobInput, actor: str) -> dict[str, Any] | None:
    if not body.submission_key:
        return None
    rows = await db.select("job_submissions", {
        "select": "jobs(*)",
        "store_id": f"eq.{body.store_id}",
        "actor_user_id": f"eq.{actor}",
        "submission_key": f"eq.{body.submission_key}",
        "limit": "1",
    })
    return rows[0]["jobs"] if rows else None


def validate_recipients(body: JobAttributionInput, buyer_phone: str) -> None:
    recipients = body.reward_recipients
    keys = {(item.role, item.phone) for item in recipients}
    if len(keys) != len(recipients):
        raise HTTPException(status_code=422, detail="Remove duplicate recipients")
    if any(item.phone == buyer_phone for item in recipients):
        raise HTTPException(status_code=422, detail="The customer cannot be their own recipient")
    if sum(item.role == "referrer" for item in recipients) > 1:
        raise HTTPException(status_code=422, detail="Add only one referrer")
    if sum(item.role == "companion" for item in recipients) > body.accompanying_count:
        raise HTTPException(status_code=422, detail="The companion count must cover every identified companion")


def recipient_payload(body: JobAttributionInput) -> dict[str, Any]:
    return {
        "p_accompanying_count": body.accompanying_count,
        "p_recipients": [item.model_dump(mode="json", exclude={"saved_key"}) for item in body.reward_recipients],
    }


async def resolve_saved_recipients(db: SupabaseRest, job_id: UUID, body: UpdateJobInput) -> UpdateJobInput:
    if not any(item.saved_key for item in body.reward_recipients):
        return body
    rows = await db.select("job_reward_recipients", {
        "select": "role,phone_e164,display_name_snapshot",
        "store_id": f"eq.{body.store_id}",
        "job_id": f"eq.{job_id}",
    })
    saved = {recipient_key(db, str(job_id), row["role"], row["phone_e164"]): row for row in rows}
    recipients = []
    for item in body.reward_recipients:
        if not item.saved_key:
            recipients.append(item)
            continue
        row = saved.get(item.saved_key)
        if not row or row["role"] != item.role:
            raise HTTPException(status_code=409, detail="Saved recipient changed; refresh before editing")
        recipients.append(RewardRecipientInput(role=item.role, phone=row["phone_e164"], name=row["display_name_snapshot"]))
    return body.model_copy(update={"reward_recipients": recipients})


@app.patch("/api/jobs/{job_id}")
async def update_job(
    job_id: UUID,
    body: UpdateJobInput,
    request: Request,
    user: dict[str, Any] = Depends(current_user),
):
    db, membership = await authorized_membership(request, body.store_id, user)
    job_rows = await db.select(
        "jobs",
        {
            "select": "id,status,created_by,version,customer_phone_snapshot",
            "id": f"eq.{job_id}",
            "store_id": f"eq.{body.store_id}",
            "limit": "1",
        },
    )
    if not job_rows:
        raise HTTPException(status_code=404, detail="Job not found")
    job = job_rows[0]
    if str(job["created_by"]) != str(user["id"]) or not has_permission(membership, "jobs.edit_own"):
        require_permission(membership, "jobs.edit_store")
    if body.submission_key:
        require_permission(membership, "jobs.submit")
        previous = await submitted_job(db, body, user["id"])
        if previous:
            if str(previous["id"]) != str(job_id):
                raise HTTPException(status_code=409, detail="Submission key belongs to another job")
            return job_response(previous, membership, db)
        body = await resolve_saved_recipients(db, job_id, body)
        validate_recipients(body, job["customer_phone_snapshot"])
    else:
        if job["status"] not in ("draft", "returned"):
            raise HTTPException(status_code=409, detail="Only returned jobs can be edited")
        if int(job["version"]) != body.expected_version:
            raise HTTPException(status_code=409, detail="Job changed; refresh before editing")
    await validate_catalog_prices(db, body.store_id, body.lines, membership)

    contributor_ids = sorted({str(item.user_id) for item in body.contributors})
    contributors: list[dict[str, str]] = []
    if contributor_ids:
        active_members = await db.select(
            "store_memberships",
            {
                "select": "user_id,display_name,role,status",
                "store_id": f"eq.{body.store_id}",
                "user_id": f"in.({','.join(contributor_ids)})",
                "status": "eq.active",
            },
        )
        by_id = {item["user_id"]: item for item in active_members}
        if any(user_id not in by_id for user_id in contributor_ids):
            raise HTTPException(status_code=422, detail="Choose active staff from this store")
        contributors = [
            {
                "user_id": str(item.user_id),
                "display_name_snapshot": by_id[str(item.user_id)].get("display_name") or by_id[str(item.user_id)]["role"],
                "contribution": item.contribution,
            }
            for item in body.contributors
        ]
    if body.submission_key:
        updated = await db.rpc("submit_job_card", {
            "p_store_id": str(body.store_id),
            "p_actor_user_id": user["id"],
            "p_submission_key": str(body.submission_key),
            "p_job_id": str(job_id),
            "p_expected_version": body.expected_version,
            "p_customer_phone": None,
            "p_customer_name": None,
            "p_lines": [line.model_dump(mode="json") for line in body.lines],
            "p_charges": [charge.model_dump(mode="json") for charge in body.charges],
            "p_contributors": contributors,
            "p_staff_note": body.staff_note,
            **recipient_payload(body),
        })
        return job_response(updated, membership, db)
    updated = await db.rpc(
        "update_returned_job",
        {
            "p_store_id": str(body.store_id),
            "p_job_id": str(job_id),
            "p_actor_user_id": user["id"],
            "p_expected_version": body.expected_version,
            "p_lines": [line.model_dump(mode="json") for line in body.lines],
            "p_charges": [charge.model_dump(mode="json") for charge in body.charges],
            "p_contributors": contributors,
            "p_staff_note": body.staff_note,
        },
    )
    return job_response(updated, membership, db)


@app.post("/api/jobs/{job_id}/transition")
async def transition_job(
    job_id: UUID,
    body: TransitionInput,
    request: Request,
    user: dict[str, Any] = Depends(current_user),
):
    db, membership = await authorized_membership(request, body.store_id, user)
    permission = {
        "ready": "jobs.submit",
        "checkout": "jobs.checkout",
        "returned": "jobs.return",
        "completed": "jobs.complete",
        "cancelled": "jobs.cancel",
    }[body.to_status]
    require_permission(membership, permission)
    job = await db.rpc(
        "transition_job",
        {
            "p_store_id": str(body.store_id),
            "p_job_id": str(job_id),
            "p_actor_user_id": user["id"],
            "p_to_status": body.to_status,
            "p_reason": body.reason,
            "p_expected_version": body.expected_version,
        },
    )
    return job_response(job, membership, db)


@app.post("/api/jobs/{job_id}/payments")
async def create_payment(
    job_id: UUID,
    body: PaymentInput,
    request: Request,
    user: dict[str, Any] = Depends(current_user),
):
    db, membership = await authorized_membership(request, body.store_id, user)
    require_permission(membership, "payments.record_cash" if body.method == "cash" else "payments.record_upi")
    return await db.rpc(
        "record_payment",
        {
            "p_store_id": str(body.store_id),
            "p_job_id": str(job_id),
            "p_actor_user_id": user["id"],
            "p_method": body.method,
            "p_amount_minor": body.amount_minor,
            "p_status": "confirmed" if body.method == "cash" else "pending",
            "p_reference": body.reference,
            "p_idempotency_key": str(body.idempotency_key or uuid4()),
        },
    )


@app.post("/api/jobs/{job_id}/payments/{payment_id}/confirm-upi")
async def confirm_upi_payment(
    job_id: UUID,
    payment_id: UUID,
    body: ConfirmUpiInput,
    request: Request,
    user: dict[str, Any] = Depends(current_user),
):
    db, membership = await authorized_membership(request, body.store_id, user)
    require_permission(membership, "payments.confirm_upi")
    return await db.rpc(
        "confirm_upi_payment",
        {
            "p_store_id": str(body.store_id),
            "p_payment_id": str(payment_id),
            "p_actor_user_id": user["id"],
            "p_reference": body.reference,
        },
    )


@app.post("/api/jobs/{job_id}/invoice")
async def record_invoice(
    job_id: UUID,
    body: InvoiceInput,
    request: Request,
    user: dict[str, Any] = Depends(current_user),
):
    db, membership = await authorized_membership(request, body.store_id, user)
    require_permission(membership, "billing.record")
    job = await db.select(
        "jobs",
        {"select": "id,quoted_total_minor", "id": f"eq.{job_id}", "store_id": f"eq.{body.store_id}", "limit": "1"},
    )
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    differs = body.final_total_minor != job[0]["quoted_total_minor"]
    if differs:
        require_permission(membership, "billing.approve_discrepancy")
    updated = await db.rpc(
        "record_invoice",
        {
            "p_store_id": str(body.store_id),
            "p_job_id": str(job_id),
            "p_actor_user_id": user["id"],
            "p_invoice_reference": body.invoice_reference,
            "p_final_total_minor": body.final_total_minor,
            "p_discrepancy_reason": body.discrepancy_reason,
            "p_approved_by": user["id"] if differs else None,
        },
    )
    return job_response(updated, membership, db)


@app.get("/api/billing/latest-invoice")
async def latest_invoice(
    store_id: UUID,
    request: Request,
    user: dict[str, Any] = Depends(current_user),
):
    db, membership = await authorized_membership(request, store_id, user)
    require_permission(membership, "billing.record")
    rows = await db.select("job_events", {
        "select": "reference:details->>invoice_reference",
        "store_id": f"eq.{store_id}",
        "event_type": "eq.billing.invoice_recorded",
        "order": "created_at.desc,id.desc",
        "limit": "1",
    })
    return {"reference": rows[0]["reference"] if rows else None}


@app.get("/api/reports/sales")
async def sales_report(
    store_id: UUID,
    period: Literal["day", "week", "month", "year", "custom"],
    on: date,
    request: Request,
    through: date | None = None,
    user: dict[str, Any] = Depends(current_user),
):
    db, membership = await authorized_membership(request, store_id, user)
    if membership["role"] not in {"manager", "owner"}:
        raise HTTPException(status_code=403, detail="Sales reports are available to managers and owners")

    if period == "custom" and (through is None or through < on):
        raise HTTPException(status_code=422, detail="Choose an end date on or after the start date")
    if period != "custom" and through is not None:
        raise HTTPException(status_code=422, detail="An end date is only allowed for a custom range")

    return await db.rpc("sales_report", {
        "p_store_id": str(store_id),
        "p_period": period,
        "p_date": on.isoformat(),
        "p_through": through.isoformat() if through is not None else None,
    })
