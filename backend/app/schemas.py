from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field


class LineInput(BaseModel):
    product_id: UUID | None = None
    label: str = Field(min_length=1, max_length=160)
    sku: str | None = Field(default=None, max_length=100)
    quantity: int = Field(ge=1, le=10000)
    unit_price_minor: int = Field(ge=0)
    contributor_user_id: UUID | None = None
    sort_order: int = 0


class ChargeInput(BaseModel):
    charge_id: UUID | None = None
    name: str = Field(min_length=1, max_length=120)
    quantity: int = Field(default=1, ge=1, le=1000)
    unit_amount_minor: int = Field(ge=0)
    sort_order: int = 0


class ContributorInput(BaseModel):
    user_id: UUID
    contribution: Literal["sales", "promoter", "assisted"] = "assisted"


class CreateJobInput(BaseModel):
    store_id: UUID
    customer_phone: str = Field(pattern=r"^\+[1-9][0-9]{7,14}$")
    customer_name: str | None = Field(default=None, max_length=120)
    lines: list[LineInput] = Field(min_length=1, max_length=50)
    charges: list[ChargeInput] = Field(default_factory=list, max_length=20)
    contributors: list[ContributorInput] = Field(default_factory=list, max_length=20)
    staff_note: str | None = Field(default=None, max_length=2000)


class UpdateJobInput(BaseModel):
    store_id: UUID
    expected_version: int = Field(ge=1)
    lines: list[LineInput] = Field(min_length=1, max_length=50)
    charges: list[ChargeInput] = Field(default_factory=list, max_length=20)
    contributors: list[ContributorInput] = Field(default_factory=list, max_length=20)
    staff_note: str | None = Field(default=None, max_length=2000)


class TransitionInput(BaseModel):
    store_id: UUID
    to_status: Literal["ready", "checkout", "returned", "completed", "cancelled"]
    reason: str | None = Field(default=None, max_length=500)
    expected_version: int = Field(ge=1)


class PaymentInput(BaseModel):
    store_id: UUID
    method: Literal["cash", "upi"]
    amount_minor: int = Field(gt=0)
    reference: str | None = Field(default=None, max_length=160)
    idempotency_key: UUID


class ConfirmUpiInput(BaseModel):
    store_id: UUID
    reference: str | None = Field(default=None, max_length=160)


class InvoiceInput(BaseModel):
    store_id: UUID
    invoice_reference: str = Field(min_length=1, max_length=120)
    final_total_minor: int = Field(ge=0)
    discrepancy_reason: str | None = Field(default=None, max_length=500)


class InitializeStoreInput(BaseModel):
    store_name: str = Field(min_length=1, max_length=120)
    currency_code: str = Field(default="INR", pattern=r"^[A-Z]{3}$")
    timezone: str = Field(default="Asia/Kolkata", max_length=80)


class ProductInput(BaseModel):
    store_id: UUID
    name: str = Field(min_length=1, max_length=160)
    brand: str | None = Field(default=None, max_length=100)
    sku: str | None = Field(default=None, max_length=100)
    default_unit_price_minor: int = Field(ge=0)


class ChargeCatalogInput(BaseModel):
    store_id: UUID
    name: str = Field(min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=500)
    default_amount_minor: int = Field(ge=0)
    billing_note: str | None = Field(default=None, max_length=500)
