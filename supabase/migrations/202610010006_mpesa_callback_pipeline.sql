-- Phase 3: Daraja C2B pipeline.
-- Edge functions only touch HTTP (token auth, raw storage, fast response).
-- All business rules (dedupe, matching, payment creation) live here so they can be tested in SQL.

create extension if not exists pgcrypto with schema extensions;

create or replace function public.configure_school_mpesa(
  target_school_id uuid,
  mpesa_shortcode text,
  mpesa_type text,
  consumer_key text,
  consumer_secret text,
  mpesa_environment text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  encryption_key text;
  raw_token text;
  config_row public.school_mpesa_config;
begin
  if caller_id is null or not public.can_write_school(target_school_id, array['admin']) then
    raise exception using errcode = '42501', message = 'Admin access required to configure M-Pesa.';
  end if;
  if mpesa_type not in ('paybill', 'till') then
    raise exception using errcode = '22023', message = 'Choose paybill or till.';
  end if;
  if mpesa_environment not in ('sandbox', 'production') then
    raise exception using errcode = '22023', message = 'Choose sandbox or production.';
  end if;
  if length(trim(mpesa_shortcode)) between 5 and 10 and trim(mpesa_shortcode) ~ '^[0-9]+$' then
    null;
  else
    raise exception using errcode = '22023', message = 'Enter the PayBill or Till number (digits only).';
  end if;
  if coalesce(char_length(trim(consumer_key)), 0) < 8 or coalesce(char_length(trim(consumer_secret)), 0) < 8 then
    raise exception using errcode = '22023', message = 'Daraja consumer credentials look too short.';
  end if;

  encryption_key := current_setting('app.mpesa_encryption_key', true);
  if coalesce(encryption_key, '') = '' then
    raise exception using errcode = '22023',
      message = 'M-Pesa encryption key is not configured on the server.';
  end if;

  raw_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');

  insert into public.school_mpesa_config (
    school_id, shortcode, type,
    consumer_key_encrypted, consumer_secret_encrypted,
    callback_token_hash, environment
  ) values (
    target_school_id,
    trim(mpesa_shortcode),
    mpesa_type,
    encode(extensions.pgp_sym_encrypt(trim(consumer_key), encryption_key), 'base64'),
    encode(extensions.pgp_sym_encrypt(trim(consumer_secret), encryption_key), 'base64'),
    encode(sha256(convert_to(raw_token, 'UTF8')), 'hex'),
    mpesa_environment
  )
  on conflict (school_id) do update
    set shortcode = excluded.shortcode,
        type = excluded.type,
        consumer_key_encrypted = excluded.consumer_key_encrypted,
        consumer_secret_encrypted = excluded.consumer_secret_encrypted,
        callback_token_hash = excluded.callback_token_hash,
        environment = excluded.environment,
        urls_registered_at = null,
        updated_at = now()
  returning * into config_row;

  insert into public.audit_log (school_id, user_id, action, entity, entity_id, after)
  values (
    target_school_id,
    caller_id,
    'mpesa.config_changed',
    'school_mpesa_config',
    target_school_id,
    jsonb_build_object('shortcode', config_row.shortcode, 'type', config_row.type, 'environment', config_row.environment)
  );

  -- The raw callback token is returned exactly once; only its hash is stored.
  return jsonb_build_object(
    'school_id', target_school_id,
    'shortcode', config_row.shortcode,
    'type', config_row.type,
    'environment', config_row.environment,
    'callback_token', raw_token
  );
end;
$$;

create or replace function public.get_school_mpesa_status(target_school_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  config_row public.school_mpesa_config;
begin
  if auth.uid() is null or not public.has_school_role(target_school_id, array['admin']) then
    raise exception using errcode = '42501', message = 'Admin access required.';
  end if;

  select * into config_row
  from public.school_mpesa_config c
  where c.school_id = target_school_id;

  if not found then
    return jsonb_build_object('configured', false);
  end if;

  return jsonb_build_object(
    'configured', true,
    'shortcode', config_row.shortcode,
    'type', config_row.type,
    'environment', config_row.environment,
    'urls_registered_at', config_row.urls_registered_at,
    'updated_at', config_row.updated_at
  );
end;
$$;

-- Only the service role (edge functions) may decrypt credentials.
create or replace function public.get_school_mpesa_credentials(target_school_id uuid)
returns table (
  shortcode text,
  mpesa_type text,
  consumer_key text,
  consumer_secret text,
  environment text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  encryption_key text := current_setting('app.mpesa_encryption_key', true);
begin
  if encryption_key is null or encryption_key = '' then
    raise exception using errcode = '22023', message = 'M-Pesa encryption key is not configured.';
  end if;
  return query
    select
      c.shortcode,
      c.type,
      convert_from(extensions.pgp_sym_decrypt(decode(c.consumer_key_encrypted, 'base64'), encryption_key), 'UTF8'),
      convert_from(extensions.pgp_sym_decrypt(decode(c.consumer_secret_encrypted, 'base64'), encryption_key), 'UTF8'),
      c.environment
    from public.school_mpesa_config c
    where c.school_id = target_school_id;
end;
$$;

-- Core pipeline: called by the edge function (service role) after the raw payload is stored.
create or replace function public.process_mpesa_callback(target_callback_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  callback_row public.mpesa_callbacks_raw;
  config_row public.school_mpesa_config;
  school_status text;
  receipt text;
  amount numeric(12, 2);
  bill_ref text;
  trans_time timestamptz;
  student_row public.students;
  open_term public.terms;
  payment_id uuid;
  outcome text;
begin
  select * into callback_row
  from public.mpesa_callbacks_raw r
  where r.id = target_callback_id
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'Callback not found.';
  end if;

  update public.mpesa_callbacks_raw
  set processing_status = 'processing'
  where id = callback_row.id;

  school_status := (select s.status from public.schools s where s.id = callback_row.school_id);
  if school_status is null then
    update public.mpesa_callbacks_raw set processing_status = 'rejected' where id = callback_row.id;
    return jsonb_build_object('outcome', 'rejected', 'reason', 'unknown_school');
  end if;

  select * into config_row
  from public.school_mpesa_config c
  where c.school_id = callback_row.school_id;
  if not found then
    update public.mpesa_callbacks_raw set processing_status = 'rejected' where id = callback_row.id;
    return jsonb_build_object('outcome', 'rejected', 'reason', 'school_not_configured');
  end if;

  -- A suspended school keeps its raw callbacks (no payment is lost) but records nothing.
  if school_status = 'suspended' then
    update public.mpesa_callbacks_raw set processing_status = 'rejected' where id = callback_row.id;
    return jsonb_build_object('outcome', 'rejected', 'reason', 'school_suspended');
  end if;

  receipt := nullif(trim(coalesce(callback_row.payload ->> 'TransID', '')), '');
  bill_ref := nullif(trim(coalesce(callback_row.payload ->> 'BillRefNumber', '')), '');
  amount := nullif(coalesce(callback_row.payload ->> 'TransAmount', ''), '')::numeric;
  trans_time := coalesce(
    to_timestamp(callback_row.payload ->> 'TransTime', 'YYYYMMDDHH24MISS'),
    callback_row.received_at
  );

  if receipt is null or amount is null or amount <= 0 then
    update public.mpesa_callbacks_raw set processing_status = 'rejected' where id = callback_row.id;
    return jsonb_build_object('outcome', 'rejected', 'reason', 'invalid_payload');
  end if;

  -- Safaricom shortcode guard: the payload must belong to this school's shortcode.
  if coalesce(callback_row.payload ->> 'BusinessShortCode', '') <> config_row.shortcode then
    update public.mpesa_callbacks_raw set processing_status = 'rejected' where id = callback_row.id;
    return jsonb_build_object('outcome', 'rejected', 'reason', 'shortcode_mismatch');
  end if;

  -- Deduplicate on the receipt: repeated confirmations must record one payment.
  if exists (
    select 1 from public.payments p
    where p.school_id = callback_row.school_id and p.mpesa_receipt = receipt
  ) or exists (
    select 1 from public.unmatched_payments u
    where u.school_id = callback_row.school_id and u.mpesa_receipt = receipt
  ) then
    update public.mpesa_callbacks_raw set processing_status = 'processed' where id = callback_row.id;
    return jsonb_build_object('outcome', 'duplicate', 'receipt', receipt);
  end if;

  if bill_ref is not null then
    select * into student_row
    from public.students st
    where st.school_id = callback_row.school_id
      and lower(trim(st.admission_number)) = lower(bill_ref)
      and st.status = 'active';
  end if;

  select * into open_term
  from public.terms t
  where t.school_id = callback_row.school_id and t.status = 'open'
  order by t.year desc, t.term_number desc
  limit 1;

  if student_row.id is not null and open_term.id is not null then
    insert into public.payments (
      school_id, student_id, term_id, amount, method, mpesa_receipt,
      reference, paid_at, source, recorded_by
    ) values (
      callback_row.school_id, student_row.id, open_term.id, amount, 'mpesa', receipt,
      'Daraja C2B', trans_time, 'daraja_c2b', null
    )
    on conflict (school_id, mpesa_receipt) where mpesa_receipt is not null do nothing
    returning id into payment_id;

    if payment_id is not null then
      outcome := 'matched';
    else
      outcome := 'duplicate';
    end if;
  else
    -- Never guess: no (or ambiguous) admission number goes to the unmatched queue.
    insert into public.unmatched_payments (
      school_id, mpesa_receipt, amount, bill_ref, paid_at, raw_payload, status
    ) values (
      callback_row.school_id, receipt, amount, coalesce(bill_ref, ''), trans_time, callback_row.payload, 'pending'
    )
    on conflict (school_id, mpesa_receipt) do nothing;
    outcome := 'unmatched';
  end if;

  update public.mpesa_callbacks_raw set processing_status = 'processed' where id = callback_row.id;
  return jsonb_build_object('outcome', outcome, 'receipt', receipt);
end;
$$;

-- Bursar/admin action: attach a pending unmatched payment to a student.
create or replace function public.assign_unmatched_payment(
  target_school_id uuid,
  target_unmatched_id uuid,
  target_student_id uuid,
  target_term_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  unmatched_row public.unmatched_payments;
  payment_row public.payments;
begin
  if caller_id is null or not public.can_write_school(target_school_id, array['admin', 'bursar']) then
    raise exception using errcode = '42501', message = 'Staff write access required.';
  end if;

  select * into unmatched_row
  from public.unmatched_payments u
  where u.id = target_unmatched_id
    and u.school_id = target_school_id
    and u.status = 'pending'
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'That unmatched payment is no longer pending.';
  end if;

  if not exists (
    select 1 from public.students st
    where st.id = target_student_id and st.school_id = target_school_id
  ) then
    raise exception using errcode = '22023', message = 'Student not found in this school.';
  end if;
  if not exists (
    select 1 from public.terms t
    where t.id = target_term_id and t.school_id = target_school_id
  ) then
    raise exception using errcode = '22023', message = 'Term not found in this school.';
  end if;

  insert into public.payments (
    id, school_id, student_id, term_id, amount, method, mpesa_receipt,
    reference, paid_at, source, recorded_by
  ) values (
    gen_random_uuid(), target_school_id, target_student_id, target_term_id,
    unmatched_row.amount, 'mpesa', unmatched_row.mpesa_receipt,
    'Assigned from unmatched queue', unmatched_row.paid_at, 'daraja_c2b', caller_id
  )
  on conflict (school_id, mpesa_receipt) where mpesa_receipt is not null do nothing
  returning * into payment_row;

  if payment_row.id is null then
    raise exception using errcode = '23505', message = 'This M-Pesa receipt is already recorded.';
  end if;

  update public.unmatched_payments
  set status = 'assigned', assigned_student_id = target_student_id
  where id = unmatched_row.id;

  insert into public.audit_log (school_id, user_id, action, entity, entity_id, before, after)
  values (
    target_school_id,
    caller_id,
    'payment.assigned_from_unmatched',
    'payment',
    payment_row.id,
    jsonb_build_object('unmatched_id', unmatched_row.id, 'receipt', unmatched_row.mpesa_receipt),
    jsonb_build_object('student_id', target_student_id, 'term_id', target_term_id, 'amount', payment_row.amount)
  );

  return jsonb_build_object(
    'payment_id', payment_row.id,
    'student_id', target_student_id,
    'term_id', target_term_id,
    'amount', payment_row.amount,
    'mpesa_receipt', payment_row.mpesa_receipt,
    'paid_at', payment_row.paid_at
  );
end;
$$;

revoke all on function public.configure_school_mpesa(uuid, text, text, text, text, text) from public, anon;
revoke all on function public.get_school_mpesa_status(uuid) from public, anon;
revoke all on function public.get_school_mpesa_credentials(uuid) from public, anon, authenticated;
revoke all on function public.process_mpesa_callback(uuid) from public, anon, authenticated;
revoke all on function public.assign_unmatched_payment(uuid, uuid, uuid, uuid) from public, anon;

grant execute on function public.configure_school_mpesa(uuid, text, text, text, text, text) to authenticated;
grant execute on function public.get_school_mpesa_status(uuid) to authenticated;
grant execute on function public.get_school_mpesa_credentials(uuid) to service_role;
grant execute on function public.process_mpesa_callback(uuid) to service_role;
grant execute on function public.assign_unmatched_payment(uuid, uuid, uuid, uuid) to authenticated;

-- Clients may not read school_mpesa_config directly (masked values only via get_school_mpesa_status).
-- Ensure the security definer functions above can still touch the tables they own.
grant select, insert, update on public.school_mpesa_config to authenticated;
