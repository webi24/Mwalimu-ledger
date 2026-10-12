-- Excel/CSV import: batch tracking, duplicate-safe charges, and undo.
-- Every import creates an import_batches row; created/changed records carry the
-- batch id; undo restores server-captured before-images within a safe window.

create table public.import_batches (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  user_id uuid references public.users(id) on delete set null,
  file_name text not null,
  import_type text not null check (import_type in ('students', 'payments', 'fees')),
  created_count integer not null default 0,
  updated_count integer not null default 0,
  skipped_count integer not null default 0,
  undone_at timestamptz,
  created_at timestamptz not null default now(),
  unique (id, school_id)
);

create index import_batches_school_created_idx on public.import_batches (school_id, created_at desc);

create table public.import_batch_updates (
  id bigint generated always as identity primary key,
  school_id uuid not null references public.schools(id) on delete cascade,
  batch_id uuid not null references public.import_batches(id) on delete cascade,
  entity text not null,
  entity_id uuid not null,
  before jsonb not null,
  captured_at timestamptz not null default now(),
  unique (batch_id, entity, entity_id)
);

alter table public.import_batches enable row level security;
alter table public.import_batch_updates enable row level security;
revoke all on public.import_batches, public.import_batch_updates from anon, authenticated;

alter table public.students add column import_batch_id uuid references public.import_batches(id) on delete set null;
alter table public.payments add column import_batch_id uuid references public.import_batches(id) on delete set null;
alter table public.student_charges add column import_batch_id uuid references public.import_batches(id) on delete set null;
alter table public.fee_structures add column import_batch_id uuid references public.import_batches(id) on delete set null;

create index students_import_batch_idx on public.students (school_id, import_batch_id);
create index payments_import_batch_idx on public.payments (school_id, import_batch_id);
create index student_charges_import_batch_idx on public.student_charges (school_id, import_batch_id);

alter table public.payments drop constraint payments_source_check;
alter table public.payments
  add constraint payments_source_check check (source in ('manual', 'daraja_c2b', 'import'));

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
  v_before_student jsonb;
  v_before_fee jsonb;
  v_before_fee_id uuid;
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

      -- Imports can happen offline: the batch row may not exist yet, so the
      -- first tagged operation creates a skeleton that undo can still use.
      if coalesce(nullif(record_data ->> 'import_batch_id', ''), '') <> '' then
        insert into public.import_batches (id, school_id, user_id, file_name, import_type)
        values (
          (record_data ->> 'import_batch_id')::uuid,
          target_school_id,
          auth.uid(),
          'Pending import',
          case operation_kind
            when 'payment.create' then 'payments'
            when 'fee_structure.upsert' then 'fees'
            else 'students'
          end
        ) on conflict (id) do nothing;
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
        when 'charge.create' then array['admin', 'bursar']
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
          begin
            if coalesce(nullif(record_data ->> 'import_batch_id', ''), '') <> '' then
              select to_jsonb(fs.*), fs.id into v_before_fee, v_before_fee_id
              from public.fee_structures fs
              where fs.school_id = target_school_id
                and fs.term_id = (record_data ->> 'term_id')::uuid
                and fs.class_id = (record_data ->> 'class_id')::uuid;
              if v_before_fee_id is not null then
                insert into public.import_batch_updates (school_id, batch_id, entity, entity_id, before)
                values (target_school_id, (record_data ->> 'import_batch_id')::uuid, 'fee_structures', v_before_fee_id, v_before_fee)
                on conflict do nothing;
              end if;
            end if;

            insert into public.fee_structures (id, school_id, term_id, class_id, amount, version, import_batch_id)
            values (
              coalesce(nullif(record_data ->> 'id', '')::uuid, gen_random_uuid()),
              target_school_id,
              (record_data ->> 'term_id')::uuid,
              (record_data ->> 'class_id')::uuid,
              (record_data ->> 'amount')::numeric,
              1,
              nullif(record_data ->> 'import_batch_id', '')::uuid
            )
            on conflict (school_id, term_id, class_id) do update
              set amount = excluded.amount, version = public.fee_structures.version + 1,
                  import_batch_id = excluded.import_batch_id, updated_at = now();
          end;
        when 'student.upsert' then
          begin
            v_before_student := null;
            if coalesce(nullif(record_data ->> 'import_batch_id', ''), '') <> '' then
              select to_jsonb(s.*) into v_before_student
              from public.students s
              where s.school_id = target_school_id and s.id = (record_data ->> 'id')::uuid;
              if v_before_student is not null then
                insert into public.import_batch_updates (school_id, batch_id, entity, entity_id, before)
                values (target_school_id, (record_data ->> 'import_batch_id')::uuid, 'students', (record_data ->> 'id')::uuid, v_before_student)
                on conflict do nothing;
              end if;
            end if;

            insert into public.students (
              id, school_id, admission_number, name, class_id, guardian_name,
              guardian_phone, status, enrolled_term_id, version, import_batch_id
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
              1,
              nullif(record_data ->> 'import_batch_id', '')::uuid
            )
            on conflict (id) do update
              set admission_number = excluded.admission_number, name = excluded.name,
                  class_id = excluded.class_id, guardian_name = excluded.guardian_name,
                  guardian_phone = excluded.guardian_phone, status = excluded.status,
                  enrolled_term_id = excluded.enrolled_term_id,
                  version = public.students.version + 1, updated_at = now()
              where public.students.school_id = target_school_id;

            -- A class change on re-import moves the student and lands in the audit log.
            if v_before_student is not null
              and (v_before_student ->> 'class_id') is distinct from (record_data ->> 'class_id') then
              insert into public.audit_log (school_id, user_id, action, entity, entity_id, before, after)
              values (
                target_school_id, auth.uid(), 'import.class_change', 'students',
                (record_data ->> 'id')::uuid,
                jsonb_build_object('class_id', v_before_student ->> 'class_id'),
                jsonb_build_object('class_id', record_data ->> 'class_id')
              );
            end if;
          end;
        when 'payment.create' then
          insert into public.payments (
            id, school_id, student_id, term_id, amount, method, mpesa_receipt,
            reference, paid_at, source, recorded_by, client_uuid, import_batch_id
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
            case when record_data ->> 'source' = 'import' then 'import' else 'manual' end,
            auth.uid(),
            v_operation_id,
            nullif(record_data ->> 'import_batch_id', '')::uuid
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
        when 'charge.create' then
          begin
            if nullif(trim(coalesce(record_data ->> 'source_key', '')), '') is null
              or left(trim(record_data ->> 'source_key'), 7) <> 'import:' then
              raise exception using errcode = '22023', message = 'A charge needs a source key that starts with import:.';
            end if;

            -- Idempotent by source key: a retried sync or a re-import can never
            -- apply the same opening balance twice.
            insert into public.student_charges (
              id, school_id, student_id, term_id, amount, type, source_key, import_batch_id, created_by
            ) values (
              coalesce(nullif(record_data ->> 'id', '')::uuid, gen_random_uuid()),
              target_school_id,
              (record_data ->> 'student_id')::uuid,
              (record_data ->> 'term_id')::uuid,
              (record_data ->> 'amount')::numeric,
              'adjustment',
              trim(record_data ->> 'source_key'),
              nullif(record_data ->> 'import_batch_id', '')::uuid,
              auth.uid()
            ) on conflict (school_id, source_key) do nothing;
          end;
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

create or replace function public.register_import_batch(target_school_id uuid, file_name text, import_type text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  batch_id uuid;
begin
  if auth.uid() is null or not public.can_write_school(target_school_id, array['admin', 'bursar']) then
    raise exception using errcode = '42501', message = 'This school is read-only or membership is inactive.';
  end if;
  if import_type not in ('students', 'payments', 'fees') then
    raise exception using errcode = '22023', message = 'Unknown import type.';
  end if;

  insert into public.import_batches (school_id, user_id, file_name, import_type)
  values (target_school_id, auth.uid(), coalesce(file_name, 'import'), import_type)
  returning id into batch_id;
  return batch_id;
end;
$$;

create or replace function public.complete_import_batch(
  target_school_id uuid,
  target_batch_id uuid,
  created_count integer,
  updated_count integer,
  skipped_count integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  batch public.import_batches;
begin
  if auth.uid() is null or not public.can_write_school(target_school_id, array['admin', 'bursar']) then
    raise exception using errcode = '42501', message = 'This school is read-only or membership is inactive.';
  end if;

  select * into batch from public.import_batches b
  where b.id = target_batch_id and b.school_id = target_school_id;
  if not found then
    raise exception using errcode = '22023', message = 'This import batch was not found for this school.';
  end if;

  update public.import_batches
  set created_count = greatest(coalesce(created_count, 0), 0),
      updated_count = greatest(coalesce(updated_count, 0), 0),
      skipped_count = greatest(coalesce(skipped_count, 0), 0)
  where id = batch.id;

  insert into public.audit_log (school_id, user_id, action, entity, entity_id, after)
  values (
    target_school_id, auth.uid(), 'import.complete', 'import_batch', batch.id,
    jsonb_build_object(
      'import_type', batch.import_type,
      'file_name', batch.file_name,
      'created', coalesce(created_count, 0),
      'updated', coalesce(updated_count, 0),
      'skipped', coalesce(skipped_count, 0)
    )
  );
end;
$$;

create or replace function public.undo_import_batch(target_school_id uuid, target_batch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  batch public.import_batches;
  removed_count integer := 0;
  restored_count integer := 0;
begin
  if auth.uid() is null or not public.can_write_school(target_school_id, array['admin']) then
    raise exception using errcode = '42501', message = 'Only a school administrator can undo an import.';
  end if;

  select * into batch from public.import_batches b
  where b.id = target_batch_id and b.school_id = target_school_id;
  if not found then
    raise exception using errcode = '22023', message = 'This import batch was not found for this school.';
  end if;
  if batch.undone_at is not null then
    raise exception using errcode = '22023', message = 'This import was already undone.';
  end if;
  if batch.created_at < now() - interval '72 hours' then
    raise exception using errcode = '22023', message = 'This import is older than the 72-hour undo window.';
  end if;

  if batch.import_type = 'students' then
    if exists (
      select 1 from public.payments p
      join public.students s on s.id = p.student_id and s.school_id = p.school_id
      where s.import_batch_id = batch.id and p.voided_at is null
    ) then
      raise exception using errcode = '22023',
        message = 'Payments have been recorded against students from this import, so it can no longer be undone.';
    end if;
    if exists (
      select 1 from public.students s
      where s.import_batch_id = batch.id and s.version > 1
    ) then
      raise exception using errcode = '22023',
        message = 'A student from this import was edited after the import, so it can no longer be undone.';
    end if;
    if exists (
      select 1 from public.student_charges c
      join public.students s on s.id = c.student_id and s.school_id = c.school_id
      where s.import_batch_id = batch.id
        and (c.import_batch_id is null or c.import_batch_id <> batch.id)
    ) then
      raise exception using errcode = '22023',
        message = 'Later charges reference students from this import, so it can no longer be undone.';
    end if;
    if exists (
      select 1 from public.unmatched_payments up
      join public.students s on s.id = up.assigned_student_id and s.school_id = up.school_id
      where s.import_batch_id = batch.id
    ) then
      raise exception using errcode = '22023',
        message = 'M-Pesa payments were assigned to students from this import, so it can no longer be undone.';
    end if;

    delete from public.student_charges where school_id = target_school_id and import_batch_id = batch.id;
    select count(*) into removed_count from public.students where school_id = target_school_id and import_batch_id = batch.id;
    delete from public.students where school_id = target_school_id and import_batch_id = batch.id;
  elsif batch.import_type = 'payments' then
    if exists (
      select 1 from public.payments p
      where p.school_id = target_school_id and p.import_batch_id = batch.id and p.voided_at is not null
    ) then
      raise exception using errcode = '22023',
        message = 'A payment from this import was already voided, so it can no longer be undone.';
    end if;
    select count(*) into removed_count from public.payments where school_id = target_school_id and import_batch_id = batch.id;
    delete from public.payments where school_id = target_school_id and import_batch_id = batch.id;
  end if;

  -- Restore field edits that this batch made to records that already existed.
  with restore as (
    update public.students s
    set name = coalesce(u.before ->> 'name', s.name),
        class_id = coalesce((u.before ->> 'class_id')::uuid, s.class_id),
        guardian_name = coalesce(u.before ->> 'guardian_name', s.guardian_name),
        guardian_phone = coalesce(u.before ->> 'guardian_phone', s.guardian_phone),
        status = coalesce(u.before ->> 'status', s.status),
        version = s.version + 1,
        updated_at = now()
    from public.import_batch_updates u
    where u.school_id = target_school_id and u.batch_id = batch.id and u.entity = 'students'
      and s.id = u.entity_id and s.school_id = target_school_id
    returning 1
  )
  select restored_count + count(*) into restored_count from restore;

  with restore as (
    update public.fee_structures fs
    set amount = (u.before ->> 'amount')::numeric,
        version = fs.version + 1,
        updated_at = now()
    from public.import_batch_updates u
    where u.school_id = target_school_id and u.batch_id = batch.id and u.entity = 'fee_structures'
      and fs.id = u.entity_id and fs.school_id = target_school_id
    returning 1
  )
  select restored_count + count(*) into restored_count from restore;

  delete from public.import_batch_updates where school_id = target_school_id and batch_id = batch.id;

  update public.import_batches set undone_at = now() where id = batch.id;

  insert into public.audit_log (school_id, user_id, action, entity, entity_id, after)
  values (
    target_school_id, auth.uid(), 'import.undo', 'import_batch', batch.id,
    jsonb_build_object(
      'import_type', batch.import_type,
      'file_name', batch.file_name,
      'removed', removed_count,
      'restored', restored_count
    )
  );

  return jsonb_build_object('removed', removed_count, 'restored', restored_count);
end;
$$;

grant execute on function public.push_sync_batch(uuid, jsonb) to authenticated;
grant execute on function public.register_import_batch(uuid, text, text) to authenticated;
grant execute on function public.complete_import_batch(uuid, uuid, integer, integer, integer) to authenticated;
grant execute on function public.undo_import_batch(uuid, uuid) to authenticated;
revoke all on function public.push_sync_batch(uuid, jsonb) from public, anon;
revoke all on function public.register_import_batch(uuid, text, text) from public, anon;
revoke all on function public.complete_import_batch(uuid, uuid, integer, integer, integer) from public, anon;
revoke all on function public.undo_import_batch(uuid, uuid) from public, anon;
