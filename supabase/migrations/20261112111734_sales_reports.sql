create index job_events_invoice_period_idx
  on public.job_events (store_id, created_at)
  include (job_id)
  where event_type = 'billing.invoice_recorded';

create function public.sales_report(p_store_id uuid, p_period text, p_date date)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with period_start as (
    select
      timezone,
      currency_code,
      date_trunc(p_period, p_date::timestamp) as starts_on,
      case p_period
        when 'day' then interval '1 day'
        when 'week' then interval '1 week'
        when 'year' then interval '1 year'
      end as duration
    from public.stores
    where id = p_store_id and p_period in ('day', 'week', 'year')
  ),
  bounds as (
    select *,
      starts_on + duration as ends_on,
      starts_on at time zone timezone as starts_at,
      (starts_on + duration) at time zone timezone as ends_at
    from period_start
  ),
  first_invoices as (
    select event.job_id, min(event.created_at) as recorded_at
    from bounds
    join public.job_events event
      on event.store_id = p_store_id
      and event.event_type = 'billing.invoice_recorded'
      and event.created_at >= bounds.starts_at
      and event.created_at < bounds.ends_at
    where not exists (
      select 1 from public.job_events earlier
      where earlier.store_id = event.store_id
        and earlier.job_id = event.job_id
        and earlier.event_type = 'billing.invoice_recorded'
        and earlier.created_at < bounds.starts_at
    )
    group by event.job_id
  ),
  invoices as (
    select job.job_number, job.invoice_reference, job.final_billed_total_minor as total_minor,
      first_invoices.recorded_at,
      date_trunc(
        case when p_period = 'year' then 'month' else 'day' end,
        first_invoices.recorded_at at time zone bounds.timezone
      ) as bucket_start
    from first_invoices
    join public.jobs job on job.store_id = p_store_id and job.id = first_invoices.job_id
    cross join bounds
    where job.status <> 'cancelled'
      and job.invoice_reference is not null
      and job.final_billed_total_minor is not null
  ),
  bucket_totals as (
    select bucket_start, count(*) as invoice_count, sum(total_minor) as total_minor
    from invoices
    group by bucket_start
  ),
  buckets as (
    select bucket.start_on::date as date,
      coalesce(bucket_totals.invoice_count, 0) as invoice_count,
      coalesce(bucket_totals.total_minor, 0) as total_minor
    from bounds
    cross join lateral generate_series(
      bounds.starts_on,
      bounds.ends_on - interval '1 day',
      case when p_period = 'year' then interval '1 month' else interval '1 day' end
    ) as bucket(start_on)
    left join bucket_totals on bucket_totals.bucket_start = bucket.start_on
    where p_period in ('week', 'year')
  )
  select jsonb_build_object(
    'currency_code', bounds.currency_code,
    'invoice_count', (select count(*) from invoices),
    'total_minor', (select coalesce(sum(total_minor), 0) from invoices),
    'buckets', coalesce((select jsonb_agg(to_jsonb(buckets) order by date) from buckets), '[]'::jsonb),
    'invoices', case when p_period = 'day' then coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'job_number', job_number, 'invoice_reference', invoice_reference, 'total_minor', total_minor
        ) order by recorded_at desc, job_number desc
      ) from invoices
    ), '[]'::jsonb) else '[]'::jsonb end
  )
  from bounds;
$$;

revoke all on function public.sales_report(uuid, text, date) from public, anon, authenticated;
grant execute on function public.sales_report(uuid, text, date) to service_role;
