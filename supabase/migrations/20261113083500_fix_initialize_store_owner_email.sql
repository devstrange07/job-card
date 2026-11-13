-- initialize_store ran as `security invoker` and tried to read auth.users to
-- resolve the owner's email. The authenticator/service_role has no SELECT
-- grant on auth.users, so every first-time setup failed with
-- "permission denied for table users" (42501). The caller (our API) already
-- verifies the user's access token and knows their email, so pass it in
-- directly instead of reading auth.users from inside the database function.

drop function if exists public.initialize_store(uuid, text, text, text, text);

create function public.initialize_store(
  p_owner_user_id uuid,
  p_store_name text,
  p_owner_email text,
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
  v_owner_email text := lower(btrim(p_owner_email));
begin
  perform pg_advisory_xact_lock(hashtext('job-card-first-store-bootstrap'));
  if exists (select 1 from public.stores) then
    raise exception 'Store setup has already been completed' using errcode = '23505';
  end if;

  if v_owner_email is null or v_owner_email = '' then
    raise exception 'Owner email is required' using errcode = '22023';
  end if;

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
revoke all on function public.initialize_store(uuid, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.initialize_store(uuid, text, text, text, text, text)
  to service_role;
