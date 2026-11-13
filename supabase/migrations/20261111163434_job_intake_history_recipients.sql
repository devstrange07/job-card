alter table public.jobs
  add column accompanying_count integer not null default 0 check (accompanying_count between 0 and 100);

create table public.job_reward_recipients (
  store_id uuid not null,
  job_id uuid not null,
  role text not null check (role in ('companion', 'referrer')),
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  display_name_snapshot text not null check (length(btrim(display_name_snapshot)) between 1 and 120),
  customer_id uuid,
  primary key (store_id, job_id, role, phone_e164),
  foreign key (store_id, job_id) references public.jobs (store_id, id) on delete cascade,
  foreign key (store_id, customer_id) references public.customers (store_id, id)
);

create unique index job_reward_recipients_one_referrer_idx
  on public.job_reward_recipients (store_id, job_id) where role = 'referrer';
create index job_reward_recipients_customer_idx on public.job_reward_recipients (store_id, customer_id);

create table public.job_submissions (
  store_id uuid not null,
  actor_user_id uuid not null references auth.users (id),
  submission_key uuid not null,
  job_id uuid not null,
  primary key (store_id, actor_user_id, submission_key),
  foreign key (store_id, job_id) references public.jobs (store_id, id) on delete cascade
);
create index job_submissions_job_idx on public.job_submissions (store_id, job_id);
create index job_submissions_actor_idx on public.job_submissions (actor_user_id);

alter table public.job_reward_recipients enable row level security;
alter table public.job_submissions enable row level security;
revoke all on public.job_reward_recipients, public.job_submissions from public, anon, authenticated;
grant select, insert, delete on public.job_reward_recipients to service_role;
grant select, insert on public.job_submissions to service_role;

create function public.submit_job_card(
  p_store_id uuid,
  p_actor_user_id uuid,
  p_submission_key uuid,
  p_job_id uuid,
  p_expected_version integer,
  p_customer_phone text,
  p_customer_name text,
  p_lines jsonb,
  p_charges jsonb,
  p_contributors jsonb,
  p_staff_note text,
  p_accompanying_count integer,
  p_recipients jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job_id uuid;
  v_job jsonb;
  v_customer_name text;
begin
  perform pg_advisory_xact_lock(hashtextextended(
    'job-submission:' || p_store_id || ':' || p_actor_user_id || ':' || p_submission_key, 0
  ));
  select job_id into v_job_id from public.job_submissions
  where store_id = p_store_id and actor_user_id = p_actor_user_id and submission_key = p_submission_key;
  if found then
    if p_job_id is not null and p_job_id <> v_job_id then
      raise exception 'Submission key belongs to another job' using errcode = '23505';
    end if;
    return (select to_jsonb(j) from public.jobs j where j.store_id = p_store_id and j.id = v_job_id);
  end if;

  if p_job_id is null then
    perform pg_advisory_xact_lock(hashtextextended('job-customer:' || p_store_id || ':' || p_customer_phone, 0));
    select display_name into v_customer_name from public.customers
    where store_id = p_store_id and phone_e164 = p_customer_phone
    for update;
    if not found and nullif(btrim(p_customer_name), '') is null then
      raise exception 'Enter the new customer’s name' using errcode = '22023';
    end if;
    v_job := public.create_job(p_store_id, p_customer_phone,
      coalesce(nullif(btrim(v_customer_name), ''), p_customer_name), p_actor_user_id,
      p_lines, p_charges, p_contributors, p_staff_note);
  else
    v_job := public.update_returned_job(p_store_id, p_job_id, p_actor_user_id,
      p_expected_version, p_lines, p_charges, p_contributors, p_staff_note);
    v_job := public.transition_job(p_store_id, p_job_id, p_actor_user_id,
      'ready', null, (v_job->>'version')::integer);
  end if;
  v_job_id := (v_job->>'id')::uuid;

  update public.jobs set accompanying_count = p_accompanying_count
  where store_id = p_store_id and id = v_job_id;
  delete from public.job_reward_recipients where store_id = p_store_id and job_id = v_job_id;
  if exists (
    select 1 from jsonb_to_recordset(p_recipients) as r(role text, phone text, name text)
    left join public.customers c on c.store_id = p_store_id and c.phone_e164 = r.phone
    where coalesce(nullif(btrim(c.display_name), ''), nullif(btrim(r.name), '')) is null
  ) then
    raise exception 'Enter a name for each recipient without a saved name' using errcode = '22023';
  end if;
  insert into public.job_reward_recipients (store_id, job_id, role, phone_e164, display_name_snapshot, customer_id)
  select p_store_id, v_job_id, r.role, r.phone, coalesce(nullif(btrim(c.display_name), ''), btrim(r.name)), c.id
  from jsonb_to_recordset(p_recipients) as r(role text, phone text, name text)
  left join public.customers c on c.store_id = p_store_id and c.phone_e164 = r.phone;

  insert into public.job_submissions (store_id, actor_user_id, submission_key, job_id)
  values (p_store_id, p_actor_user_id, p_submission_key, v_job_id);
  return v_job || jsonb_build_object('accompanying_count', p_accompanying_count);
end;
$$;

revoke all on function public.submit_job_card(uuid, uuid, uuid, uuid, integer, text, text, jsonb, jsonb, jsonb, text, integer, jsonb)
  from public, anon, authenticated;
grant execute on function public.submit_job_card(uuid, uuid, uuid, uuid, integer, text, text, jsonb, jsonb, jsonb, text, integer, jsonb)
  to service_role;
