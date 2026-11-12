-- Staff invitations are intentionally separate from memberships: an email
-- invitation alone never grants store access. Membership becomes active only
-- after the invitee authenticates and accepts the invitation.

alter table public.store_memberships
  add column email text;

update public.store_memberships as membership
set email = lower(auth_user.email)
from auth.users as auth_user
where auth_user.id = membership.user_id
  and membership.email is null
  and auth_user.email is not null;

alter table public.store_memberships
  add constraint store_memberships_email_normalized_check
  check (email is null or email = lower(btrim(email)));

create table public.staff_invitations (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  email text not null check (email = lower(btrim(email))),
  display_name text not null check (length(btrim(display_name)) between 1 and 120),
  role text not null check (role in ('manager', 'cashier', 'salesperson', 'promoter')),
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'revoked', 'expired', 'failed')),
  invited_by uuid not null references auth.users(id),
  accepted_user_id uuid references auth.users(id),
  expires_at timestamptz not null default (now() + interval '1 hour'),
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'accepted') = (accepted_at is not null)),
  check ((status = 'accepted') = (accepted_user_id is not null))
);

create unique index staff_invitations_one_pending_email_idx
  on public.staff_invitations (store_id, email)
  where status = 'pending';
create index store_memberships_store_email_idx
  on public.store_memberships (store_id, email)
  where email is not null;
create index staff_invitations_store_status_created_idx
  on public.staff_invitations (store_id, status, created_at desc);

create table public.staff_access_events (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  actor_user_id uuid not null references auth.users(id),
  subject_user_id uuid references auth.users(id),
  subject_email text,
  action text not null check (action in (
    'invited', 'invite_resent', 'invite_cancelled', 'invite_accepted',
    'role_changed', 'suspended', 'reactivated'
  )),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index staff_access_events_store_created_idx
  on public.staff_access_events (store_id, created_at desc);

alter table public.staff_invitations enable row level security;
alter table public.staff_access_events enable row level security;
revoke all on public.staff_invitations, public.staff_access_events
  from public, anon, authenticated;
grant select, insert, update, delete
  on public.staff_invitations, public.staff_access_events to service_role;

-- Keep the first owner's verified Auth email available to the manager roster.
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
  v_owner_email text;
begin
  perform pg_advisory_xact_lock(hashtext('job-card-first-store-bootstrap'));
  if exists (select 1 from public.stores) then
    raise exception 'Store setup has already been completed' using errcode = '23505';
  end if;

  select lower(auth_user.email) into v_owner_email
  from auth.users as auth_user
  where auth_user.id = p_owner_user_id;

  insert into public.stores (name, currency_code, timezone)
  values (p_store_name, p_currency_code, p_timezone)
  returning * into v_store;

  insert into public.store_memberships (store_id, user_id, email, display_name, role, status)
  values (
    v_store.id, p_owner_user_id, v_owner_email,
    nullif(btrim(p_owner_display_name), ''), 'owner', 'active'
  );

  return to_jsonb(v_store);
end;
$$;
revoke all on function public.initialize_store(uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.initialize_store(uuid, text, text, text, text)
  to service_role;

create or replace function public.accept_staff_invitation(
  p_invitation_id uuid,
  p_user_id uuid,
  p_verified_email text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_invitation public.staff_invitations;
  v_membership public.store_memberships;
begin
  select * into v_invitation
  from public.staff_invitations
  where id = p_invitation_id
  for update;

  if found and v_invitation.status = 'accepted'
     and v_invitation.accepted_user_id = p_user_id
     and v_invitation.email = lower(btrim(p_verified_email)) then
    select * into v_membership
    from public.store_memberships
    where store_id = v_invitation.store_id and user_id = p_user_id;
    return to_jsonb(v_membership);
  end if;

  if not found or v_invitation.status <> 'pending' or v_invitation.expires_at <= now() then
    raise exception 'Invitation is no longer available' using errcode = 'P0002';
  end if;
  if lower(btrim(p_verified_email)) <> v_invitation.email then
    raise exception 'Signed-in email does not match the invitation' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.store_memberships
    where store_id = v_invitation.store_id and user_id = p_user_id
  ) then
    raise exception 'This account already has a membership in the store' using errcode = '23505';
  end if;

  insert into public.store_memberships (
    store_id, user_id, email, display_name, role, status
  ) values (
    v_invitation.store_id, p_user_id, v_invitation.email,
    v_invitation.display_name, v_invitation.role, 'active'
  ) returning * into v_membership;

  update public.staff_invitations
  set status = 'accepted', accepted_user_id = p_user_id,
      accepted_at = now(), updated_at = now()
  where id = p_invitation_id;

  insert into public.staff_access_events (
    store_id, actor_user_id, subject_user_id, subject_email, action, details
  ) values (
    v_invitation.store_id, p_user_id, p_user_id, v_invitation.email,
    'invite_accepted', jsonb_build_object('role', v_invitation.role)
  );

  return to_jsonb(v_membership);
end;
$$;
revoke all on function public.accept_staff_invitation(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.accept_staff_invitation(uuid, uuid, text)
  to service_role;
