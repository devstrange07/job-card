# Job Card System — Implementation Plan

**Status:** Initial foundation implemented; live Supabase setup and pilot work remain  
**Purpose:** Plan the first usable release of a sales-to-cashier coordination app for a mobile-accessories shop.

## 1. Product direction

Build a fast, shared job-card workflow that carries a sale from the sales floor to the cashier. The app supports customer lookup, item and charge details, staff attribution, payment tracking, and a copy-ready handoff. The existing private billing software has no available API, so staff will transfer approved job details from the cashier screen into it manually. It remains the source of truth for tax calculation, official invoices, and accounting.

The first release should prove that a salesperson can prepare and hand off a sale with less repeated communication, and that the cashier can reconcile the job against the final bill.

## 2. Decisions and remaining questions

Confirmed by the owner:

1. **Billing software:** private system; APIs are blocked and no integration is available. Staff will copy/paste job details into it.
2. **Payment authority:** both cashier and sales staff may collect/finalize, controlled by permissions.
3. **Customer phone:** required for every job.

Also confirmed for the first release:

4. **Catalog and price source:** app-managed catalog plus custom lines.
5. **Tax and final amount:** the app shows a quote; cashier enters the final invoice total from the billing system.
6. **UPI behavior:** record UPI manually in the first release; defer QR until merchant details are available. A displayed QR must never be treated as proof of payment.

Still to confirm during pilot setup: supported Android, iOS, and Windows devices/browsers, the shop's tax/rounding behavior, and the internet-outage fallback.

Customer history from before rollout cannot be fetched from the billing system. The app can accumulate purchase history from jobs created after launch. Backfilling older history would require a deliberate manual-entry/import process and is not included in the first release.

## 3. Recommended first-release scope

### Include

- Staff sign-in and permission-based access for salesperson, cashier, manager, and administrator. Promoters can be represented as job participants with restricted, job-scoped access if they need to sign in.
- Create a job quickly with a required customer phone number, optional customer details, items, quantity, agreed unit price, discount if permitted, notes, and salesperson/promoter attribution.
- Provide a cashier/manager view with a clean, copy-ready summary of customer, products, prices, charges, and totals for manual entry into the billing software. Capture the official invoice reference and final amount afterward; do not imply that the app creates or syncs invoices.
- Choose an app-managed catalog, free-form job lines, or both, since the private billing catalog cannot be accessed. Avoid suggesting catalog prices are guaranteed to match the billing system.
- Add configurable extra charges. Copy the selected charge name, price, and applicable tax metadata onto the job so later configuration changes do not rewrite history.
- Explicit job workflow: draft, ready for checkout, returned for correction, checkout in progress, completed, or cancelled. Record who changed the state, when, and the correction/cancellation reason.
- Cashier queue with live updates, item/charge breakdown, job owner and contributors, total, correction action, payment tracking, and invoice reference.
- Permission-controlled payment collection/finalization for cash, UPI, or a split across methods. Track requested, recorded, confirmed, and outstanding amounts separately. MVP UPI confirmation is manual unless provider access is confirmed.
- Store final invoice number/reference and final billed total. Show a discrepancy when the billing total differs from the job total; require a reason or manager approval to close it.
- Audit history for prices, discounts, charges, payment events, corrections, cancellations, and invoice linkage.
- Responsive installable React PWA for Android, iOS, and Windows browsers, with a clear update-available prompt.

### Defer until validated

- Automated invoice creation, billing-system integration, or automatic verification that copied details match the final invoice.
- Payment-provider QR, webhook verification, refunds, and automatic reconciliation.
- Full offline editing and synchronization.
- Recommendations, loyalty/marketing campaigns, advanced analytics, commissions, inventory management, and multiple-store operations.
- Native Android/iOS packages or a Windows desktop wrapper unless a required scanner, printer, device-management, or offline capability cannot be served by the PWA.

## 4. Core workflows to design and validate

### Salesperson

1. Enter the required customer phone number, then start a job.
2. Search/select items or add a permitted custom line; set quantity and quoted price.
3. Add optional configured charges and participants.
4. Review the calculated total and send the job to checkout.
5. If returned, see the reason, correct the job, and resubmit.

### Cashier

1. See new ready jobs arrive in a live queue; open one without asking the salesperson to repeat details.
2. Check item, price, charge, and customer details; return a job with a reason or proceed.
3. If permitted, record one or more payment entries and confirm what was actually received.
4. Copy the job summary into the private billing software and create the official invoice there; capture invoice reference and billed total in the app.
5. Complete only when required payment and invoice conditions are met, or use a permissioned exception with a reason.

### Manager/admin

- Review exceptions and audit history; manage staff, permissions, charges, and (if needed) the app catalog.
- Configure separate permissions for recording cash/UPI collection, confirming a UPI receipt, discounting, editing a ready job, overriding a discrepancy, cancelling, or reversing a payment entry. Collection and verification can be assigned independently to sales staff and cashiers.

## 5. Architecture proposal

- **Frontend:** React + TypeScript, responsive PWA, role-specific routes/views in one application.
- **API:** FastAPI modular monolith. Keep pricing, totals, permissions, job transitions, payment recording, and audit writes in validated server-side operations.
- **Identity/data:** Supabase Auth and Postgres. Use explicit staff/store membership and permissions. Apply database row-level security to any direct client access; keep privileged service credentials server-side.
- **Live queue:** Supabase Realtime notifications for cashier updates, followed by an API/database refresh. Persisted database records remain authoritative.
- **Billing boundary:** there is no software integration. Treat copy/paste as the supported handoff, format the cashier summary for low-friction transfer, and capture invoice reference/amount manually. Keep this boundary explicit in the UI and data model so an integration could be added later if access changes.
- **Deployment:** hosted web frontend and API with managed Postgres/Auth; HTTPS, backups, environment separation, and centralized release/update handling. Select hosting/provider details after checking the repository, budget, and manual billing handoff needs.
- **Concurrency:** version jobs or use conditional updates to prevent a cashier and salesperson from silently overwriting each other.
- **Money:** store amounts in integer minor units (paise) with an explicit currency. Calculate totals on the server and retain price/charge snapshots. The billing system’s rounding and tax rules must be reconciled before the pilot.

Keep the initial deployment simple. Do not split into microservices. If multi-store operation is a real near-term requirement, include `store_id` in business records and authorization from the first migration; otherwise validate whether that extra scope is wanted before adding it.

## 6. Delivery phases and review gates

### Phase 0 — Discovery and workflow confirmation

- Map how the cashier currently transcribes a sale into the private billing software, which fields must be copied, invoice process, tax/charge behavior, catalog quality, and current cashier handoff.
- Observe or map representative sales: accessory-only, identified repeat customer, multiple contributors, split payment, correction, and invoice/job discrepancy.
- Confirm catalog approach, promoter access, pilot devices, and outage fallback. Phone is required and payment authority is permission-based per owner decision.
- **Gate:** owner approves workflow boundaries, permission model, and the exact fields/format in the manual copy/paste handoff.

### Phase 1 — Product and technical foundation

- Inspect/initialize the repository; agree on frontend/backend layout, local development setup, and deployment target.
- Define permission matrix, job/payment state transitions, API contracts, and data model.
- Set up Supabase project environments, Auth, schema migrations, RLS policies, FastAPI service structure, and React PWA shell. Model phone as required for every job and make payment actions permission-controlled.
- Establish audit event format, money representation, configuration/secrets handling, backups, and basic operational logging.
- **Gate:** review data model and security rules before building the transaction workflow.

### Phase 2 — Job creation and cashier handoff

- Implement sign-in and staff/store roles.
- Implement required phone capture, catalog/custom line flow, job editing, item-level staff attribution as needed, configured charge snapshots, total calculation, and job state history.
- Build mobile salesperson flow and desktop/tablet cashier queue with correction-and-resubmit.
- Add realtime notification and reliable refresh/reconnect behavior.
- **Gate:** pilot walkthrough confirms the handoff is faster and complete enough for cashiers.

### Phase 3 — Payment and billing reconciliation

- Implement cash, UPI, and split payment records; outstanding balance and duplicate-entry safeguards; enforce collection/finalization permissions for both cashier and sales staff as configured.
- For manual UPI, define who verifies receipt and what evidence/reference is recorded; never treat QR display or a screenshot alone as confirmation.
- Add copy-ready job summary; capture invoice reference and final billed total after manual billing; surface and resolve discrepancies with permissioned reasons. Since there is no integration, the cashier remains responsible for entering the official bill correctly.
- Add manager approval paths for discounts, overrides, cancellations, and reversals.
- **Gate:** reconcile sample transactions against the existing billing software with the shop owner/cashier.

### Phase 4 — Pilot, rollout, and operating procedure

- Trial with a small set of staff and real devices; measure job preparation/handoff time, corrections, abandoned jobs, and invoice discrepancies.
- Train staff on sign-in/session switching, handoffs, UPI confirmation, corrections, and internet-outage fallback.
- Configure production roles and charges; verify backup/restore process and support/contact procedure.
- Roll out PWA installation by URL/QR and document update behavior. Keep a manual billing fallback during pilot.
- **Gate:** owner accepts pilot results and authorizes wider staff rollout.

### Phase 5 — Evidence-led extensions

- Add customer highlights from app-created jobs only after privacy rules and the customer profile model are confirmed. Historical purchases predating rollout require a separate manual import/entry decision.
- Add provider-verified dynamic UPI QR only after merchant onboarding and reconciliation behavior are confirmed.
- Add offline drafts, native packaging, analytics, inventory, multi-store, or commission features only when pilot evidence or a concrete operational need justifies them.

## 7. Key risks and mitigations

| Risk | Plan |
|---|---|
| Billing software has no API or integration path | Keep the app complementary; use copy-ready handoff, a chosen app catalog/custom-line strategy, and manual invoice-reference capture. Do not duplicate accounting. |
| Job total differs from official invoice | Agree on pricing/tax authority; show differences and require reason/approval. |
| App total is mistaken for the official invoice total | Label the job total as a handoff estimate, preserve the billing software as tax/invoice authority, and record/resolve the actual invoice difference. |
| UPI marked paid without actual receipt | Separate QR/request from confirmation; record method, amount, reference, confirmer, and timestamp. |
| Shared devices blur accountability | Individual logins, short idle lock, fast account switching, and actor/timestamp audit. |
| Staff find job entry slower than verbal handoff | Optimize for quick item entry, test with actual staff, and track time and correction rate in pilot. |
| Connectivity outage interrupts work | Online-first MVP with explicit manual fallback; do not promise financial/offline sync until designed and tested. |
| Customer details are overexposed | Phone is required by owner decision; mask it in queues, restrict purchase history, and limit promoter visibility. |

## 8. Acceptance criteria for the pilot

- A salesperson can prepare and submit a representative accessory sale without repeating its details verbally.
- Every job has a valid phone number, and a cashier can identify the job, its contributors, item/charge breakdown, and current state from the queue.
- The cashier can copy the approved job summary into the billing software and record the resulting invoice reference and total back into the app.
- Corrections return to the originating workflow with a reason and leave an audit record.
- Cash, UPI, and split entries reconcile to the amount due; incomplete payment cannot appear as confirmed paid.
- The invoice reference and any difference from the job total are retained and visible.
- A role cannot perform actions outside its approved permissions, and sensitive history is not broadly visible.
- Staff can install and receive updates on the selected Android, iOS, and Windows devices.
- The pilot owner can review completion time, correction rate, abandoned jobs, and discrepancies before expanding rollout.

## 9. Owner review

The owner approved this plan for implementation. The initial local foundation now includes the PWA workflow shell, demo mode, FastAPI service structure, permission checks, and a Supabase migration. Review the code and migration before applying them to the live project. Billing integration remains out of scope unless access changes.
