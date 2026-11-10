-- Job Card System core schema.
-- Money is stored as integer paise. This application stores a quote; the billing
-- system remains authoritative for tax calculation and the final invoice total.

create table public.stores (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 120),
  currency_code text not null default 'INR' check (currency_code ~ '^[A-Z]{3}$'),
  timezone text not null default 'Asia/Kolkata',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.store_memberships (
  store_id uuid not null references public.stores(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text,
  role text not null check (role in ('owner', 'admin', 'manager', 'cashier', 'salesperson', 'promoter')),
  status text not null default 'active' check (status in ('active', 'suspended')),
  allow_permissions text[] not null default '{}',
  deny_permissions text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (store_id, user_id),
  check (display_name is null or length(btrim(display_name)) <= 120)
);
create index store_memberships_user_idx on public.store_memberships (user_id, status);

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  display_name text,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, id),
  unique (store_id, phone_e164),
  check (display_name is null or length(btrim(display_name)) <= 120)
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 160),
  brand text,
  sku text,
  default_unit_price_minor bigint not null check (default_unit_price_minor >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, id),
  check (brand is null or length(btrim(brand)) <= 100),
  check (sku is null or length(btrim(sku)) <= 100)
);
create index products_store_active_name_idx on public.products (store_id, is_active, name);

create table public.charge_catalog (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  description text,
  default_amount_minor bigint not null check (default_amount_minor >= 0),
  billing_note text,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, id)
);
create index charge_catalog_store_active_order_idx on public.charge_catalog (store_id, is_active, sort_order);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  job_number bigint generated always as identity,
  customer_id uuid not null,
  customer_phone_snapshot text not null check (customer_phone_snapshot ~ '^\+[1-9][0-9]{7,14}$'),
  customer_name_snapshot text,
  created_by uuid not null references auth.users(id),
  owner_user_id uuid not null references auth.users(id),
  status text not null default 'draft' check (status in ('draft', 'ready', 'returned', 'checkout', 'completed', 'cancelled')),
  currency_code text not null default 'INR' check (currency_code ~ '^[A-Z]{3}$'),
  quoted_total_minor bigint not null default 0 check (quoted_total_minor >= 0),
  staff_note text,
  correction_reason text,
  invoice_reference text,
  final_billed_total_minor bigint check (final_billed_total_minor is null or final_billed_total_minor >= 0),
  invoice_discrepancy_reason text,
  invoice_discrepancy_approved_by uuid references auth.users(id),
  version integer not null default 1 check (version > 0),
  submitted_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, id),
  unique (job_number),
  foreign key (store_id, customer_id) references public.customers(store_id, id),
  check (customer_name_snapshot is null or length(btrim(customer_name_snapshot)) <= 120),
  check (staff_note is null or length(staff_note) <= 2000),
  check (invoice_reference is null or length(btrim(invoice_reference)) <= 120)
);
create index jobs_store_status_created_idx on public.jobs (store_id, status, created_at desc);
create index jobs_store_customer_created_idx on public.jobs (store_id, customer_id, created_at desc);
create index jobs_created_by_idx on public.jobs (created_by);
create index jobs_owner_user_idx on public.jobs (owner_user_id);
create index jobs_discrepancy_approver_idx on public.jobs (invoice_discrepancy_approved_by);

create table public.job_contributors (
  store_id uuid not null,
  job_id uuid not null,
  user_id uuid not null references auth.users(id),
  display_name_snapshot text,
  contribution text not null default 'assisted' check (contribution in ('sales', 'promoter', 'assisted')),
  created_at timestamptz not null default now(),
  primary key (job_id, user_id),
  check (display_name_snapshot is null or length(btrim(display_name_snapshot)) <= 120),
  foreign key (store_id, job_id) references public.jobs(store_id, id) on delete cascade
);
create index job_contributors_store_user_idx on public.job_contributors (store_id, user_id);

create table public.job_line_items (
  id bigint generated always as identity primary key,
  store_id uuid not null,
  job_id uuid not null,
  product_id uuid,
  label_snapshot text not null check (length(btrim(label_snapshot)) between 1 and 160),
  sku_snapshot text,
  quantity integer not null check (quantity between 1 and 10000),
  unit_price_minor bigint not null check (unit_price_minor >= 0),
  line_total_minor bigint generated always as (quantity::bigint * unit_price_minor) stored,
  contributor_user_id uuid references auth.users(id),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  foreign key (store_id, job_id) references public.jobs(store_id, id) on delete cascade,
  foreign key (store_id, product_id) references public.products(store_id, id)
);
create index job_line_items_store_job_idx on public.job_line_items (store_id, job_id, sort_order);
create index job_line_items_product_idx on public.job_line_items (store_id, product_id);
create index job_line_items_contributor_idx on public.job_line_items (contributor_user_id);

create table public.job_charge_items (
  id bigint generated always as identity primary key,
  store_id uuid not null,
  job_id uuid not null,
  charge_id uuid,
  name_snapshot text not null check (length(btrim(name_snapshot)) between 1 and 120),
  quantity integer not null default 1 check (quantity between 1 and 1000),
  unit_amount_minor bigint not null check (unit_amount_minor >= 0),
  line_total_minor bigint generated always as (quantity::bigint * unit_amount_minor) stored,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  foreign key (store_id, job_id) references public.jobs(store_id, id) on delete cascade,
  foreign key (store_id, charge_id) references public.charge_catalog(store_id, id)
);
create index job_charge_items_store_job_idx on public.job_charge_items (store_id, job_id, sort_order);
create index job_charge_items_charge_idx on public.job_charge_items (store_id, charge_id);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null,
  job_id uuid not null,
  method text not null check (method in ('cash', 'upi')),
  amount_minor bigint not null check (amount_minor > 0),
  status text not null default 'confirmed' check (status in ('pending', 'confirmed', 'reversed')),
  reference text,
  idempotency_key uuid not null,
  recorded_by uuid not null references auth.users(id),
  confirmed_by uuid references auth.users(id),
  confirmed_at timestamptz,
  reversed_by uuid references auth.users(id),
  reversed_at timestamptz,
  reversal_reason text,
  created_at timestamptz not null default now(),
  foreign key (store_id, job_id) references public.jobs(store_id, id) on delete cascade,
  unique (store_id, idempotency_key),
  check (method <> 'cash' or status <> 'pending'),
  check (reference is null or length(btrim(reference)) <= 160),
  check (status <> 'confirmed' or (confirmed_by is not null and confirmed_at is not null)),
  check (status <> 'reversed' or (reversed_by is not null and reversed_at is not null and reversal_reason is not null))
);
create index payments_store_job_status_idx on public.payments (store_id, job_id, status);
create index payments_recorded_by_idx on public.payments (recorded_by);
create index payments_confirmed_by_idx on public.payments (confirmed_by);
create index payments_reversed_by_idx on public.payments (reversed_by);

create table public.job_events (
  id bigint generated always as identity primary key,
  store_id uuid not null,
  job_id uuid not null,
  actor_user_id uuid not null references auth.users(id),
  event_type text not null check (length(btrim(event_type)) between 1 and 80),
  reason text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (store_id, job_id) references public.jobs(store_id, id) on delete cascade
);
create index job_events_store_job_created_idx on public.job_events (store_id, job_id, created_at desc);
create index job_events_actor_idx on public.job_events (actor_user_id);

-- All application tables live in the exposed public schema. The PWA calls the
-- FastAPI service; it does not query these tables directly. RLS is enabled and
-- direct anon/authenticated table access is revoked. The API's secret key stays
-- server-side and its authorization checks are mandatory on every operation.
alter table public.stores enable row level security;
alter table public.store_memberships enable row level security;
alter table public.customers enable row level security;
alter table public.products enable row level security;
alter table public.charge_catalog enable row level security;
alter table public.jobs enable row level security;
alter table public.job_contributors enable row level security;
alter table public.job_line_items enable row level security;
alter table public.job_charge_items enable row level security;
alter table public.payments enable row level security;
alter table public.job_events enable row level security;

revoke all on public.stores, public.store_memberships, public.customers, public.products,
  public.charge_catalog, public.jobs, public.job_contributors, public.job_line_items,
  public.job_charge_items, public.payments, public.job_events from public, anon, authenticated;
grant usage on schema public to service_role;
grant select, insert, update, delete on public.stores, public.store_memberships,
  public.customers, public.products, public.charge_catalog, public.jobs,
  public.job_contributors, public.job_line_items, public.job_charge_items,
  public.payments, public.job_events to service_role;
grant usage, select on all sequences in schema public to service_role;

create or replace function public.create_job(
  p_store_id uuid,
  p_customer_phone text,
  p_customer_name text,
  p_created_by uuid,
  p_lines jsonb,
  p_charges jsonb default '[]'::jsonb,
  p_contributors jsonb default '[]'::jsonb,
  p_staff_note text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_customer_id uuid;
  v_job public.jobs;
begin
  if p_customer_phone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'Customer phone must be in E.164 format' using errcode = '22023';
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' then
    raise exception 'Job lines must be an array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_lines) = 0 then
    raise exception 'At least one job line is required' using errcode = '22023';
  end if;
  if jsonb_typeof(p_charges) is distinct from 'array' or jsonb_typeof(p_contributors) is distinct from 'array' then
    raise exception 'Charges and contributors must be arrays' using errcode = '22023';
  end if;

  insert into public.customers (store_id, phone_e164, display_name)
  values (p_store_id, p_customer_phone, nullif(btrim(p_customer_name), ''))
  on conflict (store_id, phone_e164) do update
    set display_name = coalesce(excluded.display_name, public.customers.display_name),
        updated_at = now()
  returning id into v_customer_id;

  insert into public.jobs (
    store_id, customer_id, customer_phone_snapshot, customer_name_snapshot,
    created_by, owner_user_id, staff_note, status, submitted_at
  ) values (
    p_store_id, v_customer_id, p_customer_phone, nullif(btrim(p_customer_name), ''),
    p_created_by, p_created_by, nullif(btrim(p_staff_note), ''), 'ready', now()
  ) returning * into v_job;

  insert into public.job_line_items (
    store_id, job_id, product_id, label_snapshot, sku_snapshot,
    quantity, unit_price_minor, contributor_user_id, sort_order
  )
  select p_store_id, v_job.id, x.product_id, x.label, x.sku,
         x.quantity, x.unit_price_minor, x.contributor_user_id, x.sort_order
  from jsonb_to_recordset(p_lines) as x(
    product_id uuid, label text, sku text, quantity integer,
    unit_price_minor bigint, contributor_user_id uuid, sort_order integer
  );

  insert into public.job_charge_items (
    store_id, job_id, charge_id, name_snapshot, quantity, unit_amount_minor, sort_order
  )
  select p_store_id, v_job.id, x.charge_id, x.name, x.quantity,
         x.unit_amount_minor, x.sort_order
  from jsonb_to_recordset(p_charges) as x(
    charge_id uuid, name text, quantity integer, unit_amount_minor bigint, sort_order integer
  );

  insert into public.job_contributors (store_id, job_id, user_id, display_name_snapshot, contribution)
  select p_store_id, v_job.id, x.user_id, x.display_name_snapshot, x.contribution
  from jsonb_to_recordset(p_contributors) as x(user_id uuid, display_name_snapshot text, contribution text)
  on conflict (job_id, user_id) do nothing;

  update public.jobs j
  set quoted_total_minor = coalesce((
    select sum(li.line_total_minor) from public.job_line_items li
    where li.store_id = p_store_id and li.job_id = v_job.id
  ), 0) + coalesce((
    select sum(ci.line_total_minor) from public.job_charge_items ci
    where ci.store_id = p_store_id and ci.job_id = v_job.id
  ), 0),
      updated_at = now()
  where j.id = v_job.id and j.store_id = p_store_id
  returning * into v_job;

  insert into public.job_events (store_id, job_id, actor_user_id, event_type, details)
  values (p_store_id, v_job.id, p_created_by, 'job.created',
          jsonb_build_object('status', v_job.status, 'quoted_total_minor', v_job.quoted_total_minor));

  return to_jsonb(v_job);
end;
$$;
revoke all on function public.create_job(uuid, text, text, uuid, jsonb, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.create_job(uuid, text, text, uuid, jsonb, jsonb, jsonb, text) to service_role;

create or replace function public.update_returned_job(
  p_store_id uuid,
  p_job_id uuid,
  p_actor_user_id uuid,
  p_expected_version integer,
  p_lines jsonb,
  p_charges jsonb,
  p_contributors jsonb,
  p_staff_note text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job public.jobs;
begin
  select * into v_job
  from public.jobs
  where id = p_job_id and store_id = p_store_id
  for update;
  if not found then raise exception 'Job not found' using errcode = 'P0002'; end if;
  if v_job.status not in ('draft', 'returned') then
    raise exception 'Only returned jobs can be edited' using errcode = '22023';
  end if;
  if v_job.version <> p_expected_version then
    raise exception 'Job changed; refresh before retrying' using errcode = '40001';
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' then
    raise exception 'Job lines must be an array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_lines) = 0 then
    raise exception 'At least one job line is required' using errcode = '22023';
  end if;
  if jsonb_typeof(p_charges) is distinct from 'array' or jsonb_typeof(p_contributors) is distinct from 'array' then
    raise exception 'Charges and contributors must be arrays' using errcode = '22023';
  end if;

  delete from public.job_line_items where store_id = p_store_id and job_id = p_job_id;
  delete from public.job_charge_items where store_id = p_store_id and job_id = p_job_id;
  delete from public.job_contributors where store_id = p_store_id and job_id = p_job_id;

  insert into public.job_line_items (
    store_id, job_id, product_id, label_snapshot, sku_snapshot,
    quantity, unit_price_minor, contributor_user_id, sort_order
  )
  select p_store_id, p_job_id, x.product_id, x.label, x.sku,
         x.quantity, x.unit_price_minor, x.contributor_user_id, x.sort_order
  from jsonb_to_recordset(p_lines) as x(
    product_id uuid, label text, sku text, quantity integer,
    unit_price_minor bigint, contributor_user_id uuid, sort_order integer
  );

  insert into public.job_charge_items (
    store_id, job_id, charge_id, name_snapshot, quantity, unit_amount_minor, sort_order
  )
  select p_store_id, p_job_id, x.charge_id, x.name, x.quantity,
         x.unit_amount_minor, x.sort_order
  from jsonb_to_recordset(p_charges) as x(
    charge_id uuid, name text, quantity integer, unit_amount_minor bigint, sort_order integer
  );

  insert into public.job_contributors (store_id, job_id, user_id, display_name_snapshot, contribution)
  select p_store_id, p_job_id, x.user_id, x.display_name_snapshot, x.contribution
  from jsonb_to_recordset(p_contributors) as x(user_id uuid, display_name_snapshot text, contribution text)
  on conflict (job_id, user_id) do nothing;

  update public.jobs j
  set staff_note = nullif(btrim(p_staff_note), ''),
      correction_reason = null,
      quoted_total_minor = coalesce((
        select sum(li.line_total_minor) from public.job_line_items li
        where li.store_id = p_store_id and li.job_id = p_job_id
      ), 0) + coalesce((
        select sum(ci.line_total_minor) from public.job_charge_items ci
        where ci.store_id = p_store_id and ci.job_id = p_job_id
      ), 0),
      version = version + 1,
      updated_at = now()
  where j.id = p_job_id and j.store_id = p_store_id
  returning * into v_job;

  insert into public.job_events (store_id, job_id, actor_user_id, event_type, details)
  values (p_store_id, p_job_id, p_actor_user_id, 'job.corrected',
          jsonb_build_object('version', v_job.version, 'quoted_total_minor', v_job.quoted_total_minor));
  return to_jsonb(v_job);
end;
$$;
revoke all on function public.update_returned_job(uuid, uuid, uuid, integer, jsonb, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.update_returned_job(uuid, uuid, uuid, integer, jsonb, jsonb, jsonb, text) to service_role;

create or replace function public.transition_job(
  p_store_id uuid,
  p_job_id uuid,
  p_actor_user_id uuid,
  p_to_status text,
  p_reason text,
  p_expected_version integer
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job public.jobs;
  v_paid bigint;
begin
  select * into v_job
  from public.jobs
  where id = p_job_id and store_id = p_store_id
  for update;
  if not found then raise exception 'Job not found' using errcode = 'P0002'; end if;
  if v_job.version <> p_expected_version then
    raise exception 'Job changed; refresh before retrying' using errcode = '40001';
  end if;

  if not (
    (v_job.status = 'draft' and p_to_status in ('ready', 'cancelled')) or
    (v_job.status = 'returned' and p_to_status in ('ready', 'cancelled')) or
    (v_job.status = 'ready' and p_to_status in ('checkout', 'returned', 'cancelled')) or
    (v_job.status = 'checkout' and p_to_status in ('completed', 'returned', 'cancelled'))
  ) then
    raise exception 'Invalid job state transition: % to %', v_job.status, p_to_status using errcode = '22023';
  end if;
  if p_to_status in ('returned', 'cancelled') and nullif(btrim(p_reason), '') is null then
    raise exception 'A reason is required' using errcode = '22023';
  end if;
  if p_to_status = 'completed' then
    if v_job.invoice_reference is null or v_job.final_billed_total_minor is null then
      raise exception 'Record the official invoice before completing the job' using errcode = '22023';
    end if;
    select coalesce(sum(amount_minor), 0) into v_paid
    from public.payments
    where store_id = p_store_id and job_id = p_job_id and status = 'confirmed';
    if v_paid < v_job.final_billed_total_minor then
      raise exception 'Confirmed payments do not cover the final bill total' using errcode = '22023';
    end if;
  end if;
  if p_to_status = 'cancelled' and exists (
    select 1 from public.payments
    where store_id = p_store_id and job_id = p_job_id and status = 'confirmed'
  ) then
    raise exception 'Reverse confirmed payments before cancelling' using errcode = '22023';
  end if;

  update public.jobs
  set status = p_to_status,
      correction_reason = case when p_to_status = 'returned' then p_reason else null end,
      submitted_at = case when p_to_status = 'ready' then coalesce(submitted_at, now()) else submitted_at end,
      completed_at = case when p_to_status = 'completed' then now() else completed_at end,
      cancelled_at = case when p_to_status = 'cancelled' then now() else cancelled_at end,
      version = version + 1,
      updated_at = now()
  where id = p_job_id and store_id = p_store_id
  returning * into v_job;

  insert into public.job_events (store_id, job_id, actor_user_id, event_type, reason, details)
  values (p_store_id, p_job_id, p_actor_user_id, 'job.status_changed', p_reason,
          jsonb_build_object('status', v_job.status, 'version', v_job.version));
  return to_jsonb(v_job);
end;
$$;
revoke all on function public.transition_job(uuid, uuid, uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.transition_job(uuid, uuid, uuid, text, text, integer) to service_role;

create or replace function public.record_payment(
  p_store_id uuid,
  p_job_id uuid,
  p_actor_user_id uuid,
  p_method text,
  p_amount_minor bigint,
  p_status text,
  p_reference text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job public.jobs;
  v_payment public.payments;
begin
  select * into v_job from public.jobs
  where id = p_job_id and store_id = p_store_id for update;
  if not found then raise exception 'Job not found' using errcode = 'P0002'; end if;
  if v_job.status <> 'checkout' then
    raise exception 'Payments can only be recorded during checkout' using errcode = '22023';
  end if;
  if p_method not in ('cash', 'upi') or p_status not in ('pending', 'confirmed') then
    raise exception 'Unsupported payment method or status' using errcode = '22023';
  end if;
  if p_method = 'cash' and p_status <> 'confirmed' then
    raise exception 'Cash must be recorded as received' using errcode = '22023';
  end if;
  if p_method = 'upi' and p_status = 'confirmed' then
    raise exception 'UPI confirmation must use the confirmation operation' using errcode = '22023';
  end if;

  insert into public.payments (
    store_id, job_id, method, amount_minor, status, reference,
    idempotency_key, recorded_by, confirmed_by, confirmed_at
  ) values (
    p_store_id, p_job_id, p_method, p_amount_minor, p_status,
    nullif(btrim(p_reference), ''), p_idempotency_key, p_actor_user_id,
    case when p_status = 'confirmed' then p_actor_user_id else null end,
    case when p_status = 'confirmed' then now() else null end
  )
  on conflict (store_id, idempotency_key) do nothing
  returning * into v_payment;

  if v_payment.id is null then
    select * into v_payment from public.payments
    where store_id = p_store_id and idempotency_key = p_idempotency_key;
  else
    insert into public.job_events (store_id, job_id, actor_user_id, event_type, details)
    values (p_store_id, p_job_id, p_actor_user_id, 'payment.recorded',
            jsonb_build_object('payment_id', v_payment.id, 'method', v_payment.method,
                               'amount_minor', v_payment.amount_minor, 'status', v_payment.status));
  end if;
  return to_jsonb(v_payment);
end;
$$;
revoke all on function public.record_payment(uuid, uuid, uuid, text, bigint, text, text, uuid) from public, anon, authenticated;
grant execute on function public.record_payment(uuid, uuid, uuid, text, bigint, text, text, uuid) to service_role;

create or replace function public.confirm_upi_payment(
  p_store_id uuid,
  p_payment_id uuid,
  p_actor_user_id uuid,
  p_reference text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_payment public.payments;
begin
  update public.payments
  set status = 'confirmed',
      reference = coalesce(nullif(btrim(p_reference), ''), reference),
      confirmed_by = p_actor_user_id,
      confirmed_at = now()
  where id = p_payment_id and store_id = p_store_id and method = 'upi' and status = 'pending'
  returning * into v_payment;
  if not found then raise exception 'Pending UPI payment not found' using errcode = 'P0002'; end if;
  insert into public.job_events (store_id, job_id, actor_user_id, event_type, details)
  values (p_store_id, v_payment.job_id, p_actor_user_id, 'payment.upi_confirmed',
          jsonb_build_object('payment_id', v_payment.id, 'amount_minor', v_payment.amount_minor));
  return to_jsonb(v_payment);
end;
$$;
revoke all on function public.confirm_upi_payment(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.confirm_upi_payment(uuid, uuid, uuid, text) to service_role;

create or replace function public.record_invoice(
  p_store_id uuid,
  p_job_id uuid,
  p_actor_user_id uuid,
  p_invoice_reference text,
  p_final_total_minor bigint,
  p_discrepancy_reason text,
  p_approved_by uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job public.jobs;
begin
  select * into v_job from public.jobs
  where id = p_job_id and store_id = p_store_id for update;
  if not found then raise exception 'Job not found' using errcode = 'P0002'; end if;
  if v_job.status <> 'checkout' then
    raise exception 'Invoice details can only be recorded during checkout' using errcode = '22023';
  end if;
  if nullif(btrim(p_invoice_reference), '') is null or p_final_total_minor < 0 then
    raise exception 'Invoice reference and a non-negative final total are required' using errcode = '22023';
  end if;
  if p_final_total_minor <> v_job.quoted_total_minor and nullif(btrim(p_discrepancy_reason), '') is null then
    raise exception 'A reason is required when the final bill differs from the quote' using errcode = '22023';
  end if;
  if p_final_total_minor <> v_job.quoted_total_minor and p_approved_by is null then
    raise exception 'Manager approval is required for a bill discrepancy' using errcode = '22023';
  end if;

  update public.jobs
  set invoice_reference = btrim(p_invoice_reference),
      final_billed_total_minor = p_final_total_minor,
      invoice_discrepancy_reason = nullif(btrim(p_discrepancy_reason), ''),
      invoice_discrepancy_approved_by = p_approved_by,
      version = version + 1,
      updated_at = now()
  where id = p_job_id and store_id = p_store_id
  returning * into v_job;

  insert into public.job_events (store_id, job_id, actor_user_id, event_type, reason, details)
  values (p_store_id, p_job_id, p_actor_user_id, 'billing.invoice_recorded', p_discrepancy_reason,
          jsonb_build_object('invoice_reference', v_job.invoice_reference,
                             'final_billed_total_minor', v_job.final_billed_total_minor,
                             'quoted_total_minor', v_job.quoted_total_minor,
                             'approved_by', p_approved_by));
  return to_jsonb(v_job);
end;
$$;
revoke all on function public.record_invoice(uuid, uuid, uuid, text, bigint, text, uuid) from public, anon, authenticated;
grant execute on function public.record_invoice(uuid, uuid, uuid, text, bigint, text, uuid) to service_role;

create or replace function public.initialize_store(
  p_owner_user_id uuid,
  p_store_name text,
  p_currency_code text default 'INR',
  p_timezone text default 'Asia/Kolkata',
  p_owner_display_name text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_store public.stores;
begin
  perform pg_advisory_xact_lock(hashtext('job-card-first-store-bootstrap'));
  if exists (select 1 from public.stores) then
    raise exception 'Store setup has already been completed' using errcode = '23505';
  end if;

  insert into public.stores (name, currency_code, timezone)
  values (p_store_name, p_currency_code, p_timezone)
  returning * into v_store;

  insert into public.store_memberships (store_id, user_id, display_name, role, status)
  values (v_store.id, p_owner_user_id, nullif(btrim(p_owner_display_name), ''), 'owner', 'active');

  return to_jsonb(v_store);
end;
$$;
revoke all on function public.initialize_store(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.initialize_store(uuid, text, text, text, text) to service_role;
