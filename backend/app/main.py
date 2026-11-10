from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any
from uuid import UUID, uuid4

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware

from app.permissions import permissions_for, require_permission
from app.schemas import (
    ChargeCatalogInput,
    ConfirmUpiInput,
    CreateJobInput,
    InitializeStoreInput,
    InvoiceInput,
    PaymentInput,
    ProductInput,
    TransitionInput,
    UpdateJobInput,
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


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "job-card-api"}


@app.get("/api/session")
async def session(request: Request, user: dict[str, Any] = Depends(current_user)):
    db = rest(request)
    memberships = await db.select(
        "store_memberships",
        {
            "select": "store_id,display_name,role,status,allow_permissions,deny_permissions,store:stores(id,name,currency_code,timezone,is_active)",
            "user_id": f"eq.{user['id']}",
            "status": "eq.active",
            "store.is_active": "eq.true",
        },
    )
    return {
        "user": {"id": user["id"], "email": user.get("email")},
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
            "select": "user_id,display_name,role,status",
            "store_id": f"eq.{store_id}",
            "status": "eq.active",
            "order": "created_at.asc",
        },
    )


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
    params = {
        "select": "*,job_line_items(*),job_charge_items(*),payments(*),job_contributors(*)",
        "store_id": f"eq.{store_id}",
        "order": "created_at.desc",
        "limit": "100",
    }
    if status:
        params["status"] = f"eq.{status}"
    if "jobs.read_store" not in permissions and "*" not in permissions:
        params["created_by"] = f"eq.{user['id']}"
    return await db.select("jobs", params)


@app.post("/api/jobs")
async def create_job(
    body: CreateJobInput,
    request: Request,
    user: dict[str, Any] = Depends(current_user),
):
    db, membership = await authorized_membership(request, body.store_id, user)
    require_permission(membership, "jobs.create")
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
    return await db.rpc(
        "create_job",
        {
            "p_store_id": str(body.store_id),
            "p_customer_phone": body.customer_phone,
            "p_customer_name": body.customer_name,
            "p_created_by": user["id"],
            "p_lines": [line.model_dump(mode="json") for line in body.lines],
            "p_charges": [charge.model_dump(mode="json") for charge in body.charges],
            "p_contributors": contributor_snapshots,
            "p_staff_note": body.staff_note,
        },
    )


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
            "select": "id,status,created_by,version",
            "id": f"eq.{job_id}",
            "store_id": f"eq.{body.store_id}",
            "limit": "1",
        },
    )
    if not job_rows:
        raise HTTPException(status_code=404, detail="Job not found")
    job = job_rows[0]
    if job["status"] not in ("draft", "returned"):
        raise HTTPException(status_code=409, detail="Only returned jobs can be edited")
    if str(job["created_by"]) == str(user["id"]):
        require_permission(membership, "jobs.edit_own")
    else:
        require_permission(membership, "jobs.edit_store")
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
    return await db.rpc(
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
    return await db.rpc(
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
    return await db.rpc(
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
