create extension if not exists pgtap with schema extensions;

begin;
select extensions.plan(10);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('12000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sync-admin@example.test', '', now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"name":"Sync Admin"}'),
  ('12000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sync-bursar@example.test', '', now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"name":"Sync Bursar"}');

insert into public.schools (id, name, status)
values ('22000000-0000-0000-0000-000000000001', 'Sync School', 'active');
insert into public.memberships (user_id, school_id, role) values
  ('12000000-0000-0000-0000-000000000001', '22000000-0000-0000-0000-000000000001', 'admin'),
  ('12000000-0000-0000-0000-000000000002', '22000000-0000-0000-0000-000000000001', 'bursar');

insert into public.classes (id, school_id, name) values
  ('32000000-0000-0000-0000-000000000001', '22000000-0000-0000-0000-000000000001', 'Grade 4');
insert into public.terms (id, school_id, year, term_number, name) values
  ('42000000-0000-0000-0000-000000000001', '22000000-0000-0000-0000-000000000001', 2026, 1, 'Term 1, 2026'),
  ('42000000-0000-0000-0000-000000000002', '22000000-0000-0000-0000-000000000001', 2026, 2, 'Term 2, 2026');
insert into public.fee_structures (school_id, term_id, class_id, amount) values
  ('22000000-0000-0000-0000-000000000001', '42000000-0000-0000-0000-000000000001', '32000000-0000-0000-0000-000000000001', 15000),
  ('22000000-0000-0000-0000-000000000001', '42000000-0000-0000-0000-000000000002', '32000000-0000-0000-0000-000000000001', 20000);
insert into public.students (
  id, school_id, admission_number, name, class_id, guardian_name, guardian_phone, enrolled_term_id
) values (
  '52000000-0000-0000-0000-000000000001', '22000000-0000-0000-0000-000000000001', 'S-001', 'Sync Student',
  '32000000-0000-0000-0000-000000000001', 'Guardian', '0712345678', '42000000-0000-0000-0000-000000000001'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '12000000-0000-0000-0000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"12000000-0000-0000-0000-000000000001","role":"authenticated"}', true);

select extensions.diag((public.push_sync_batch('22000000-0000-0000-0000-000000000001', '[{"operation_id":"62000000-0000-0000-0000-000000000001","kind":"payment.create","data":{"id":"52000000-0000-0000-0000-000000000101","student_id":"52000000-0000-0000-0000-000000000001","term_id":"42000000-0000-0000-0000-000000000001","amount":5000,"method":"cash","paid_at":"2026-01-15T09:00:00Z"}}]'::jsonb)->0)::text);
select extensions.is(
  (public.push_sync_batch('22000000-0000-0000-0000-000000000001', '[{"operation_id":"62000000-0000-0000-0000-000000000001","kind":"payment.create","data":{"id":"52000000-0000-0000-0000-000000000101","student_id":"52000000-0000-0000-0000-000000000001","term_id":"42000000-0000-0000-0000-000000000001","amount":5000,"method":"cash","paid_at":"2026-01-15T09:00:00Z"}}]'::jsonb)->0->>'status'),
  'accepted',
  'A queued manual payment is accepted'
);
select extensions.ok(
  coalesce((public.push_sync_batch('22000000-0000-0000-0000-000000000001', '[{"operation_id":"62000000-0000-0000-0000-000000000001","kind":"payment.create","data":{"id":"52000000-0000-0000-0000-000000000101","student_id":"52000000-0000-0000-0000-000000000001","term_id":"42000000-0000-0000-0000-000000000001","amount":5000,"method":"cash","paid_at":"2026-01-15T09:00:00Z"}}]'::jsonb)->0->>'replayed')::boolean,
  false
  ),
  'Replaying the same operation returns its original accepted result'
);
select extensions.is(
  (select count(*)::integer from public.payments where school_id = '22000000-0000-0000-0000-000000000001'),
  1,
  'Replaying a payment operation creates no duplicate payment'
);

select extensions.is(
  (public.rollover_school_term('22000000-0000-0000-0000-000000000001', '42000000-0000-0000-0000-000000000001')->>'fee_charges_created')::integer,
  1,
  'First term rollover creates the class fee charge'
);
select extensions.is(
  (select count(*)::integer from public.student_charges where school_id = '22000000-0000-0000-0000-000000000001' and term_id = '42000000-0000-0000-0000-000000000002'),
  0,
  'Rollover has not created charges for a later term yet'
);
select extensions.is(
  (public.rollover_school_term('22000000-0000-0000-0000-000000000001', '42000000-0000-0000-0000-000000000002')->>'carry_forwards_created')::integer,
  1,
  'Next term rollover carries forward the unpaid balance'
);
select extensions.is(
  (public.rollover_school_term('22000000-0000-0000-0000-000000000001', '42000000-0000-0000-0000-000000000002')->>'fee_charges_created')::integer,
  0,
  'Repeating rollover does not create another fee charge'
);
select extensions.is(
  ((select coalesce(sum(ch.amount), 0) from public.student_charges ch where ch.school_id = '22000000-0000-0000-0000-000000000001')
   - (select coalesce(sum(p.amount), 0) from public.payments p where p.school_id = '22000000-0000-0000-0000-000000000001' and p.voided_at is null)),
  30000::numeric,
  'Cumulative balance includes fees and carry-forward without counting debt twice'
);

select set_config('request.jwt.claim.sub', '12000000-0000-0000-0000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"12000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select extensions.is(
  (public.push_sync_batch('22000000-0000-0000-0000-000000000001', '[{"operation_id":"62000000-0000-0000-0000-000000000002","kind":"fee_structure.upsert","data":{"term_id":"42000000-0000-0000-0000-000000000002","class_id":"32000000-0000-0000-0000-000000000001","amount":1}}]'::jsonb)->0->>'reason'),
  'not_allowed',
  'A bursar cannot push fee structure changes'
);
select extensions.ok(
  coalesce(jsonb_array_length(public.pull_school_changes('22000000-0000-0000-0000-000000000001', 0)->'changes'), 0) > 0,
  'An authorized device can pull school changes from its cursor'
);

select * from extensions.finish();
rollback;
