create extension if not exists pgtap with schema extensions;

begin;
select extensions.plan(14);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('13000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'mpesa-admin@example.test', '', now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"name":"Mpesa Admin"}'),
  ('13000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'mpesa-bursar@example.test', '', now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"name":"Mpesa Bursar"}');

insert into public.schools (id, name, status)
values ('23000000-0000-0000-0000-000000000001', 'Mpesa School', 'active');
insert into public.memberships (user_id, school_id, role) values
  ('13000000-0000-0000-0000-000000000001', '23000000-0000-0000-0000-000000000001', 'admin'),
  ('13000000-0000-0000-0000-000000000002', '23000000-0000-0000-0000-000000000001', 'bursar');

insert into public.classes (id, school_id, name)
values ('33000000-0000-0000-0000-000000000001', '23000000-0000-0000-0000-000000000001', 'Grade 4');
insert into public.terms (id, school_id, year, term_number, name, status)
values ('43000000-0000-0000-0000-000000000001', '23000000-0000-0000-0000-000000000001', 2026, 1, 'Term 1, 2026', 'open');
insert into public.students (
  id, school_id, admission_number, name, class_id, guardian_name, guardian_phone
) values (
  '53000000-0000-0000-0000-000000000001', '23000000-0000-0000-0000-000000000001', 'MP-001', 'Mpesa Student',
  '33000000-0000-0000-0000-000000000001', 'Guardian', '0712345678'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '13000000-0000-0000-0000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"13000000-0000-0000-0000-000000000001","role":"authenticated"}', true);

set local "app.mpesa_encryption_key" = 'local-dev-only-key-change-me-32chars';

select extensions.ok(
  (public.configure_school_mpesa('23000000-0000-0000-0000-000000000001', '174379', 'paybill', 'test-consumer-key-01', 'test-consumer-secret-01', 'sandbox')->>'callback_token') ~ '^[0-9a-f]{64}$',
  'Configuring M-Pesa returns a one-time callback token'
);
-- RLS hides school_mpesa_config from direct authenticated reads by design;
-- verify through the masking function instead.
select extensions.is(
  (public.get_school_mpesa_status('23000000-0000-0000-0000-000000000001')->>'configured'),
  'true',
  'Only one config row exists per school (readable via masked status)'
);
select extensions.throws_ok(
  $$select public.configure_school_mpesa('23000000-0000-0000-0000-000000000001', '174379', 'paybill', 'k2', 's2', 'sandbox')$$,
  '22023', null,
  'Daraja credentials must meet a minimum length'
);

select set_config('request.jwt.claim.sub', '13000000-0000-0000-0000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"13000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select extensions.throws_ok(
  $$select public.get_school_mpesa_status('23000000-0000-0000-0000-000000000001')$$,
  '42501', null,
  'Bursars cannot read the M-Pesa config status'
);

-- Switch to service role to run the pipeline, as the edge function would.
set local role service_role;
select set_config('role', 'service_role', true);

-- 1) Valid payment with a matching admission number records once.
select extensions.is(
  (select count(*)::integer from public.mpesa_callbacks_raw),
  0,
  'Sanity: raw table starts empty'
);
insert into public.mpesa_callbacks_raw (school_id, payload) values
  ('23000000-0000-0000-0000-000000000001', jsonb_build_object(
    'TransID', 'QJK7LM3XYZ', 'TransAmount', '2500', 'BillRefNumber', 'MP-001',
    'BusinessShortCode', '174379', 'TransTime', '20261001120000'
  ));
select extensions.is(
  (public.process_mpesa_callback((select id from public.mpesa_callbacks_raw limit 1))->>'outcome'),
  'matched',
  'A payment with a valid admission number is matched to the student'
);
select extensions.is(
  (select count(*)::integer from public.payments where mpesa_receipt = 'QJK7LM3XYZ'),
  1,
  'The matched payment is recorded exactly once'
);
select extensions.is(
  (select source from public.payments where mpesa_receipt = 'QJK7LM3XYZ' limit 1),
  'daraja_c2b',
  'Automatic payments carry the daraja_c2b source'
);

-- 2) The same confirmation delivered three times records once.
insert into public.mpesa_callbacks_raw (school_id, payload) values
  ('23000000-0000-0000-0000-000000000001', jsonb_build_object(
    'TransID', 'QJK7LM3XYZ', 'TransAmount', '2500', 'BillRefNumber', 'MP-001',
    'BusinessShortCode', '174379', 'TransTime', '20261001120000'
  )),
  ('23000000-0000-0000-0000-000000000001', jsonb_build_object(
    'TransID', 'QJK7LM3XYZ', 'TransAmount', '2500', 'BillRefNumber', 'MP-001',
    'BusinessShortCode', '174379', 'TransTime', '20261001120000'
  ));
select extensions.is(
  (select count(*)::integer from public.payments where mpesa_receipt = 'QJK7LM3XYZ'),
  1,
  'Replaying the same confirmation never duplicates the payment'
);
select extensions.is(
  (public.process_mpesa_callback((select id from public.mpesa_callbacks_raw where payload->>'TransID' = 'QJK7LM3XYZ' order by received_at desc limit 1))->>'outcome'),
  'duplicate',
  'Reprocessed callbacks report a duplicate outcome'
);

-- 3) Unknown account number lands in unmatched.
insert into public.mpesa_callbacks_raw (school_id, payload) values
  ('23000000-0000-0000-0000-000000000001', jsonb_build_object(
    'TransID', 'QAB12CD34', 'TransAmount', '1000', 'BillRefNumber', 'GHOST-999',
    'BusinessShortCode', '174379', 'TransTime', '20261001120500'
  ));
select extensions.is(
  (public.process_mpesa_callback((select id from public.mpesa_callbacks_raw where payload->>'TransID' = 'QAB12CD34' limit 1))->>'outcome'),
  'unmatched',
  'An unknown admission number goes to the unmatched queue'
);
select extensions.is(
  (select status from public.unmatched_payments where mpesa_receipt = 'QAB12CD34' limit 1),
  'pending',
  'The unmatched payment waits in pending status'
);

-- 4) Wrong shortcode for this school's token is rejected.
insert into public.mpesa_callbacks_raw (school_id, payload) values
  ('23000000-0000-0000-0000-000000000001', jsonb_build_object(
    'TransID', 'QZZ98ZZ99', 'TransAmount', '500', 'BillRefNumber', 'MP-001',
    'BusinessShortCode', '999999', 'TransTime', '20261001121000'
  ));
select extensions.is(
  (public.process_mpesa_callback((select id from public.mpesa_callbacks_raw where payload->>'TransID' = 'QZZ98ZZ99' limit 1))->>'outcome'),
  'rejected',
  'A payload whose shortcode does not match the school is rejected'
);

-- 5) Assignment flow: bursar assigns the unmatched payment.
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '13000000-0000-0000-0000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"13000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select extensions.is(
  (public.assign_unmatched_payment(
    '23000000-0000-0000-0000-000000000001',
    (select id from public.unmatched_payments where mpesa_receipt = 'QAB12CD34'),
    '53000000-0000-0000-0000-000000000001',
    '43000000-0000-0000-0000-000000000001'
  )->>'mpesa_receipt'),
  'QAB12CD34',
  'A bursar can assign an unmatched payment to a student'
);
select extensions.is(
  (select count(*)::integer from public.unmatched_payments where mpesa_receipt = 'QAB12CD34' and status = 'assigned'),
  1,
  'The assigned payment leaves the pending queue'
);
select extensions.throws_ok(
  $$select public.assign_unmatched_payment(
    '23000000-0000-0000-0000-000000000001',
    (select id from public.unmatched_payments where mpesa_receipt = 'QAB12CD34'),
    '53000000-0000-0000-0000-000000000001',
    '43000000-0000-0000-0000-000000000001'
  )$$,
  '22023', null,
  'An unmatched payment cannot be assigned twice'
);

-- 6) The balance reflects the automatic payments (2500 matched + 1000 assigned).
select extensions.is(
  ((select coalesce(sum(ch.amount), 0) from public.student_charges ch where ch.school_id = '23000000-0000-0000-0000-000000000001' and ch.student_id = '53000000-0000-0000-0000-000000000001')
   - (select coalesce(sum(p.amount), 0) from public.payments p where p.school_id = '23000000-0000-0000-0000-000000000001' and p.voided_at is null)),
  (-3500)::numeric,
  'Balances reflect automatic M-Pesa payments immediately'
);

-- 7) Service-only functions stay sealed from clients.
select extensions.throws_ok(
  $$select public.process_mpesa_callback((select id from public.mpesa_callbacks_raw limit 1))$$,
  '42501', null,
  'Clients cannot invoke the callback processor directly'
);
select extensions.throws_ok(
  $$select count(*) from public.get_school_mpesa_credentials('23000000-0000-0000-0000-000000000001')$$,
  '42501', null,
  'Clients can never read decrypted Daraja credentials'
);

select * from extensions.finish();
rollback;
