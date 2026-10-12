alter table public.students
  add column enrolled_term_id uuid;

alter table public.students
  add constraint students_enrolled_term_same_school
  foreign key (enrolled_term_id, school_id) references public.terms(id, school_id);

create table public.sync_operations (
  school_id uuid not null references public.schools(id) on delete cascade,
  operation_id uuid not null,
  operation_kind text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (school_id, operation_id)
);

create table public.sync_events (
  id bigint generated always as identity primary key,
  school_id uuid not null references public.schools(id) on delete cascade,
  entity text not null,
  entity_id uuid not null,
  operation text not null check (operation in ('INSERT', 'UPDATE')),
  version integer not null default 1,
  payload jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);

create index sync_events_school_cursor_idx on public.sync_events (school_id, id);
alter table public.sync_operations enable row level security;
alter table public.sync_events enable row level security;
revoke all on public.sync_operations, public.sync_events from anon, authenticated;

create or replace function public.can_write_school(target_school_id uuid, allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.schools s
    where s.id = target_school_id
      and (
        s.status = 'active'
        or (s.status = 'trial' and s.trial_ends_at > now())
      )
      and public.has_school_role(s.id, allowed_roles)
  );
$$;

create or replace function public.capture_sync_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  row_data jsonb := to_jsonb(new);
  entity_name text := tg_table_name;
  row_version integer := coalesce((row_data ->> 'version')::integer, 1);
begin
  insert into public.sync_events (school_id, entity, entity_id, operation, version, payload)
  values (
    (row_data ->> 'school_id')::uuid,
    entity_name,
    (row_data ->> 'id')::uuid,
    tg_op,
    row_version,
    row_data
  );
  return new;
end;
$$;

create trigger classes_sync_event after insert or update on public.classes
  for each row execute function public.capture_sync_event();
create trigger terms_sync_event after insert or update on public.terms
  for each row execute function public.capture_sync_event();
create trigger fee_structures_sync_event after insert or update on public.fee_structures
  for each row execute function public.capture_sync_event();
create trigger students_sync_event after insert or update on public.students
  for each row execute function public.capture_sync_event();
create trigger charges_sync_event after insert on public.student_charges
  for each row execute function public.capture_sync_event();
create trigger payments_sync_event after insert or update on public.payments
  for each row execute function public.capture_sync_event();
create trigger unmatched_payments_sync_event after insert or update on public.unmatched_payments
  for each row execute function public.capture_sync_event();

create or replace function public.initialize_school(target_school_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  term_year integer := extract(year from current_date)::integer;
  term_number smallint;
  due_date date;
  term_id uuid;
  grade_name text;
  class_id uuid;
begin
  if caller_id is null or not public.has_school_role(target_school_id, array['admin']) then
    raise exception using errcode = '42501', message = 'Admin access required for this school.';
  end if;
  if not exists (
    select 1 from public.schools s
    where s.id = target_school_id and s.status in ('trial', 'active')
  ) then
    raise exception using errcode = '42501', message = 'This school cannot be initialized.';
  end if;

  term_number := case
    when extract(month from current_date) <= 4 then 1
    when extract(month from current_date) <= 8 then 2
    else 3
  end;
  due_date := case term_number
    when 1 then make_date(term_year, 4, 30)
    when 2 then make_date(term_year, 8, 31)
    else make_date(term_year, 11, 15)
  end;

  insert into public.terms (school_id, year, term_number, name, due_date)
  values (target_school_id, term_year, term_number, 'Term ' || term_number || ', ' || term_year, due_date)
  on conflict (school_id, year, term_number) do update set name = excluded.name
  returning id into term_id;

  foreach grade_name in array array['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6']
  loop
    insert into public.classes (school_id, name)
    values (target_school_id, grade_name)
    on conflict (school_id, name) do update set name = excluded.name
    returning id into class_id;

    insert into public.fee_structures (school_id, term_id, class_id, amount)
    values (target_school_id, term_id, class_id, 0)
    on conflict (school_id, term_id, class_id) do nothing;
  end loop;

  return jsonb_build_object('term_id', term_id, 'year', term_year, 'term_number', term_number);
end;
$$;

create or replace function public.rollover_school_term(target_school_id uuid, target_term_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_term public.terms;
  previous_term_id uuid;
  fee_count integer;
  carry_count integer;
begin
  if not public.can_write_school(target_school_id, array['admin']) then
    raise exception using errcode = '42501', message = 'Admin access required to start a term.';
  end if;

  select * into target_term
  from public.terms t
  where t.id = target_term_id and t.school_id = target_school_id;
  if not found then
    raise exception using errcode = '22023', message = 'Term does not belong to this school.';
  end if;

  select t.id into previous_term_id
  from public.terms t
  where t.school_id = target_school_id
    and (t.year, t.term_number) < (target_term.year, target_term.term_number)
  order by t.year desc, t.term_number desc
  limit 1;

  with inserted as (
    insert into public.student_charges (school_id, student_id, term_id, amount, type, source_key, created_by)
    select
      target_school_id,
      st.id,
      target_term_id,
      fs.amount,
      'fee',
      'rollover:fee:' || target_term_id::text || ':' || st.id::text,
      auth.uid()
    from public.students st
    join public.fee_structures fs
      on fs.school_id = target_school_id
      and fs.term_id = target_term_id
      and fs.class_id = st.class_id
    where st.school_id = target_school_id
      and st.status = 'active'
      and fs.amount > 0
    on conflict (school_id, source_key) do nothing
    returning 1
  ) select count(*)::integer into fee_count from inserted;

  with previous_balances as (
    select
      st.id as student_id,
      coalesce((
        select sum(ch.amount)
        from public.student_charges ch
        join public.terms charge_term
          on charge_term.id = ch.term_id and charge_term.school_id = ch.school_id
        where ch.school_id = target_school_id
          and ch.student_id = st.id
          and (charge_term.year, charge_term.term_number) < (target_term.year, target_term.term_number)
      ), 0) - coalesce((
        select sum(py.amount)
        from public.payments py
        join public.terms payment_term
          on payment_term.id = py.term_id and payment_term.school_id = py.school_id
        where py.school_id = target_school_id
          and py.student_id = st.id
          and py.voided_at is null
          and (payment_term.year, payment_term.term_number) < (target_term.year, target_term.term_number)
      ), 0) as balance
    from public.students st
    where st.school_id = target_school_id and st.status = 'active'
  ), carry_out as (
    insert into public.student_charges (school_id, student_id, term_id, amount, type, source_key, created_by)
    select
      target_school_id,
      pb.student_id,
      previous_term_id,
      -pb.balance,
      'carry_forward',
      'rollover:carry-out:' || target_term_id::text || ':' || pb.student_id::text,
      auth.uid()
    from previous_balances pb
    where previous_term_id is not null and pb.balance <> 0
    on conflict (school_id, source_key) do nothing
    returning student_id
  ), inserted as (
    insert into public.student_charges (school_id, student_id, term_id, amount, type, source_key, created_by)
    select
      target_school_id,
      pb.student_id,
      target_term_id,
      pb.balance,
      'carry_forward',
      'rollover:carry:' || target_term_id::text || ':' || pb.student_id::text,
      auth.uid()
    from previous_balances pb
    where pb.balance <> 0
    on conflict (school_id, source_key) do nothing
    returning 1
  ) select count(*)::integer into carry_count from inserted;

  update public.terms t
  set status = 'closed', updated_at = now()
  where t.school_id = target_school_id
    and t.status = 'open'
    and (t.year, t.term_number) < (target_term.year, target_term.term_number);

  return jsonb_build_object('term_id', target_term_id, 'fee_charges_created', fee_count, 'carry_forwards_created', carry_count);
end;
$$;

create or replace function public.pull_school_changes(target_school_id uuid, after_cursor bigint default 0, batch_size integer default 500)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  event_rows jsonb;
  next_cursor bigint;
begin
  if auth.uid() is null or not public.is_school_member(target_school_id) then
    raise exception using errcode = '42501', message = 'School membership required.';
  end if;

  with next_events as (
    select e.*
    from public.sync_events e
    where e.school_id = target_school_id and e.id > greatest(after_cursor, 0)
    order by e.id
    limit least(greatest(batch_size, 1), 1000)
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'cursor', ne.id,
      'entity', ne.entity,
      'entity_id', ne.entity_id,
      'operation', ne.operation,
      'version', ne.version,
      'record', ne.payload,
      'created_at', ne.created_at
    ) order by ne.id), '[]'::jsonb),
    coalesce(max(ne.id), greatest(after_cursor, 0))
  into event_rows, next_cursor
  from next_events ne;

  return jsonb_build_object('changes', event_rows, 'cursor', next_cursor, 'has_more', jsonb_array_length(event_rows) = least(greatest(batch_size, 1), 1000));
end;
$$;

create or replace function public.push_sync_batch(target_school_id uuid, operations jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  operation jsonb;
  record_data jsonb;
  v_operation_id uuid;
  operation_kind text;
  operation_result jsonb;
  previous_result jsonb;
  error_state text;
  results jsonb := '[]'::jsonb;
  expected_role text[];
  inserted_payment public.payments;
begin
  if auth.uid() is null or not public.can_write_school(target_school_id, array['admin', 'bursar']) then
    raise exception using errcode = '42501', message = 'This school is read-only or membership is inactive.';
  end if;
  if jsonb_typeof(operations) <> 'array' or jsonb_array_length(operations) > 100 then
    raise exception using errcode = '22023', message = 'Send an array of at most 100 operations.';
  end if;

  for operation in select value from jsonb_array_elements(operations)
  loop
    begin
      v_operation_id := (operation ->> 'operation_id')::uuid;
      operation_kind := operation ->> 'kind';
      record_data := operation -> 'data';
      if v_operation_id is null or jsonb_typeof(record_data) <> 'object' then
        raise exception using errcode = '22023', message = 'Invalid operation.';
      end if;

      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(target_school_id::text || ':' || v_operation_id::text, 0)
      );
      select so.result into previous_result
      from public.sync_operations so
      where so.school_id = target_school_id and so.operation_id = v_operation_id;
      if found then
        results := results || jsonb_build_array(previous_result || jsonb_build_object('replayed', true));
        continue;
      end if;

      expected_role := case operation_kind
        when 'class.upsert' then array['admin']
        when 'term.upsert' then array['admin']
        when 'fee_structure.upsert' then array['admin']
        when 'term.rollover' then array['admin']
        when 'student.upsert' then array['admin', 'bursar']
        when 'payment.create' then array['admin', 'bursar']
        else array[]::text[]
      end;
      if cardinality(expected_role) = 0 or not public.can_write_school(target_school_id, expected_role) then
        raise exception using errcode = '42501', message = 'This operation is not allowed for this role.';
      end if;

      case operation_kind
        when 'class.upsert' then
          insert into public.classes (id, school_id, name, version)
          values ((record_data ->> 'id')::uuid, target_school_id, trim(record_data ->> 'name'), 1)
          on conflict (id) do update
            set name = excluded.name, version = public.classes.version + 1, updated_at = now()
            where public.classes.school_id = target_school_id;
        when 'term.upsert' then
          insert into public.terms (id, school_id, year, term_number, name, due_date, status, version)
          values (
            (record_data ->> 'id')::uuid,
            target_school_id,
            (record_data ->> 'year')::integer,
            (record_data ->> 'term_number')::smallint,
            trim(record_data ->> 'name'),
            nullif(record_data ->> 'due_date', '')::date,
            coalesce(nullif(record_data ->> 'status', ''), 'open'),
            1
          )
          on conflict (id) do update
            set year = excluded.year, term_number = excluded.term_number, name = excluded.name,
                due_date = excluded.due_date, status = excluded.status,
                version = public.terms.version + 1, updated_at = now()
            where public.terms.school_id = target_school_id;
        when 'fee_structure.upsert' then
          insert into public.fee_structures (id, school_id, term_id, class_id, amount, version)
          values (
            coalesce(nullif(record_data ->> 'id', '')::uuid, gen_random_uuid()),
            target_school_id,
            (record_data ->> 'term_id')::uuid,
            (record_data ->> 'class_id')::uuid,
            (record_data ->> 'amount')::numeric,
            1
          )
          on conflict (school_id, term_id, class_id) do update
            set amount = excluded.amount, version = public.fee_structures.version + 1, updated_at = now();
        when 'student.upsert' then
          insert into public.students (
            id, school_id, admission_number, name, class_id, guardian_name,
            guardian_phone, status, enrolled_term_id, version
          ) values (
            (record_data ->> 'id')::uuid,
            target_school_id,
            trim(record_data ->> 'admission_number'),
            trim(record_data ->> 'name'),
            (record_data ->> 'class_id')::uuid,
            trim(record_data ->> 'guardian_name'),
            trim(record_data ->> 'guardian_phone'),
            coalesce(nullif(record_data ->> 'status', ''), 'active'),
            nullif(record_data ->> 'enrolled_term_id', '')::uuid,
            1
          )
          on conflict (id) do update
            set admission_number = excluded.admission_number, name = excluded.name,
                class_id = excluded.class_id, guardian_name = excluded.guardian_name,
                guardian_phone = excluded.guardian_phone, status = excluded.status,
                enrolled_term_id = excluded.enrolled_term_id,
                version = public.students.version + 1, updated_at = now()
            where public.students.school_id = target_school_id;
        when 'payment.create' then
          insert into public.payments (
            id, school_id, student_id, term_id, amount, method, mpesa_receipt,
            reference, paid_at, source, recorded_by, client_uuid
          ) values (
            (record_data ->> 'id')::uuid,
            target_school_id,
            (record_data ->> 'student_id')::uuid,
            (record_data ->> 'term_id')::uuid,
            (record_data ->> 'amount')::numeric,
            (record_data ->> 'method'),
            nullif(trim(record_data ->> 'mpesa_receipt'), ''),
            nullif(trim(record_data ->> 'reference'), ''),
            (record_data ->> 'paid_at')::timestamptz,
            'manual',
            auth.uid(),
            v_operation_id
          ) on conflict (school_id, client_uuid) where client_uuid is not null do nothing
          returning * into inserted_payment;

          if inserted_payment.id is null then
            select p.* into inserted_payment
            from public.payments p
            where p.school_id = target_school_id and p.client_uuid = v_operation_id;
            if inserted_payment.id is distinct from (record_data ->> 'id')::uuid
              or inserted_payment.student_id is distinct from (record_data ->> 'student_id')::uuid
              or inserted_payment.amount is distinct from (record_data ->> 'amount')::numeric then
              raise exception using errcode = '23505', message = 'Operation identifier already belongs to a different payment.';
            end if;
          end if;
        when 'term.rollover' then
          perform public.rollover_school_term(target_school_id, (record_data ->> 'term_id')::uuid);
        else
          raise exception using errcode = '22023', message = 'Unsupported operation.';
      end case;

      operation_result := jsonb_build_object('operation_id', v_operation_id, 'status', 'accepted');
      insert into public.sync_operations (school_id, operation_id, operation_kind, result)
      values (target_school_id, v_operation_id, operation_kind, operation_result);
      results := results || jsonb_build_array(operation_result);
    exception when others then
      get stacked diagnostics error_state = returned_sqlstate;
      operation_result := jsonb_build_object(
        'operation_id', coalesce(operation ->> 'operation_id', ''),
        'status', 'rejected',
        'code', error_state,
        'reason', case error_state
          when '42501' then 'not_allowed'
          when '23503' then 'related_record_missing'
          when '23505' then 'duplicate_conflict'
          when '22023' then 'invalid_data'
          when '22P02' then 'invalid_data'
          else 'validation_failed'
        end
      );
      results := results || jsonb_build_array(operation_result);
    end;
  end loop;

  return results;
end;
$$;

grant execute on function public.initialize_school(uuid) to authenticated;
grant execute on function public.rollover_school_term(uuid, uuid) to authenticated;
grant execute on function public.pull_school_changes(uuid, bigint, integer) to authenticated;
grant execute on function public.push_sync_batch(uuid, jsonb) to authenticated;
revoke all on function public.initialize_school(uuid) from public, anon;
revoke all on function public.rollover_school_term(uuid, uuid) from public, anon;
revoke all on function public.pull_school_changes(uuid, bigint, integer) from public, anon;
revoke all on function public.push_sync_batch(uuid, jsonb) from public, anon;
