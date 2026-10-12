create extension if not exists pgtap with schema extensions;

begin;
select extensions.plan(9);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin-a@example.test', '', now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"name":"Admin A"}'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'shared-manager@example.test', '', now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"name":"Shared Manager"}'),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'no-school@example.test', '', now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"name":"No School"}'),
  ('10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'platform@example.test', '', now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"name":"Platform Admin"}');

insert into public.schools (id, name, status) values
  ('20000000-0000-0000-0000-000000000001', 'School A', 'active'),
  ('20000000-0000-0000-0000-000000000002', 'School B', 'active');

insert into public.memberships (user_id, school_id, role) values
  ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'admin'),
  ('10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'bursar'),
  ('10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', 'admin');

insert into public.platform_admins (user_id)
values ('10000000-0000-0000-0000-000000000004');

insert into public.classes (id, school_id, name) values
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'Grade 4'),
  ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', 'Grade 4');

insert into public.terms (id, school_id, year, term_number, name) values
  ('40000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 2026, 1, 'Term 1, 2026'),
  ('40000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', 2026, 1, 'Term 1, 2026');

insert into public.students (id, school_id, admission_number, name, class_id, guardian_name, guardian_phone) values
  ('50000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'A-001', 'Student A', '30000000-0000-0000-0000-000000000001', 'Guardian A', '0712345678'),
  ('50000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', 'B-001', 'Student B', '30000000-0000-0000-0000-000000000002', 'Guardian B', '0722345678');

insert into public.fee_structures (school_id, term_id, class_id, amount) values
  ('20000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 15000),
  ('20000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000002', 15000);

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated"}', true);

select extensions.is(
  (select count(*)::integer from public.students where school_id = '20000000-0000-0000-0000-000000000002'),
  0,
  'School A cannot read School B student rows'
);
select extensions.throws_ok(
  $$insert into public.students (school_id, admission_number, name, class_id, guardian_name, guardian_phone)
    values ('20000000-0000-0000-0000-000000000002', 'A-999', 'Cross tenant', '30000000-0000-0000-0000-000000000002', 'Guardian', '0712345678')$$,
  '42501', null,
  'School A cannot insert a student into School B'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select extensions.is(
  (select count(*)::integer from public.get_my_schools()),
  2,
  'A person with memberships in two schools sees both schools'
);
select extensions.ok(
  exists (select 1 from public.get_my_schools() where school_id = '20000000-0000-0000-0000-000000000001' and role = 'bursar')
  and exists (select 1 from public.get_my_schools() where school_id = '20000000-0000-0000-0000-000000000002' and role = 'admin'),
  'The same person retains different roles in each school'
);
select extensions.throws_ok(
  $$insert into public.fee_structures (school_id, term_id, class_id, amount)
    values ('20000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 16000)$$,
  '42501', null,
  'A bursar cannot change a fee structure'
);
insert into public.payments (school_id, student_id, term_id, amount, method, paid_at, source, recorded_by)
values ('20000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 1000, 'cash', now(), 'manual', auth.uid());
select extensions.is(
  (select count(*)::integer from public.payments where school_id = '20000000-0000-0000-0000-000000000001'),
  1,
  'A bursar can record a manual payment for their school'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
select extensions.is(
  (select count(*)::integer from public.students),
  0,
  'A user with no school membership cannot read any students'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000004', true);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000004","role":"authenticated"}', true);
select extensions.is(
  (select count(*)::integer from public.platform_school_metrics()),
  2,
  'A platform admin can view metadata for all schools'
);
select extensions.is(
  (select count(*)::integer from public.students),
  0,
  'A platform admin cannot read student rows without a school membership'
);

select * from extensions.finish();
rollback;
