from __future__ import annotations

import re
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator, model_validator


def normalize_phone(value: str) -> str:
    cleaned = re.sub(r"[\s().-]", "", value)
    if re.fullmatch(r"[0-9]{10}", cleaned):
        cleaned = f"+91{cleaned}"
    elif re.fullmatch(r"91[0-9]{10}", cleaned):
        cleaned = f"+{cleaned}"
    if not re.fullmatch(r"\+[1-9][0-9]{7,14}", cleaned):
        raise ValueError("Enter a valid phone number with country code")
    return cleaned


class PhoneLookupInput(BaseModel):
    store_id: UUID
    phone: str = Field(max_length=40)
    _normalize_phone = field_validator("phone")(normalize_phone)


class CustomerLookupInput(PhoneLookupInput):
    offset: int = Field(default=0, ge=0)


class RewardRecipientInput(BaseModel):
    role: Literal["companion", "referrer"]
    phone: str | None = Field(default=None, max_length=40)
    saved_key: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    name: str | None = Field(default=None, max_length=120)

    @field_validator("phone")
    @classmethod
    def normalized_phone(cls, value: str | None) -> str | None:
        return normalize_phone(value) if value is not None else None

    @model_validator(mode="after")
    def one_identifier(self) -> "RewardRecipientInput":
        if bool(self.phone) == bool(self.saved_key):
            raise ValueError("Provide a phone or a saved recipient")
        return self


class JobAttributionInput(BaseModel):
    accompanying_count: int = Field(default=0, ge=0, le=100)
    reward_recipients: list[RewardRecipientInput] = Field(default_factory=list, max_length=21)
    submission_key: UUID | None = None


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


class CreateJobInput(JobAttributionInput):
    store_id: UUID
    customer_phone: str = Field(max_length=40)
    customer_name: str | None = Field(default=None, max_length=120)
    lines: list[LineInput] = Field(min_length=1, max_length=50)
    charges: list[ChargeInput] = Field(default_factory=list, max_length=20)
    contributors: list[ContributorInput] = Field(default_factory=list, max_length=20)
    staff_note: str | None = Field(default=None, max_length=2000)

    _normalize_phone = field_validator("customer_phone")(normalize_phone)


class UpdateJobInput(JobAttributionInput):
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


class InviteStaffInput(BaseModel):
    store_id: UUID
    email: str = Field(min_length=3, max_length=254)
    display_name: str = Field(min_length=1, max_length=120)
    role: Literal["salesperson", "cashier", "promoter", "manager"]


class AcceptStaffInvitationInput(BaseModel):
    invitation_id: UUID


class UpdateStaffInput(BaseModel):
    store_id: UUID
    role: Literal["salesperson", "cashier", "promoter", "manager"] | None = None
    status: Literal["active", "suspended"] | None = None


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
