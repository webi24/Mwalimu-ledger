create extension if not exists pgtap with schema extensions;

begin;
select extensions.plan(8);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('11000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@example.test', '', now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"name":"Owner"}'),
  ('11000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'bursar@example.test', '', now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"name":"Bursar"}'),
  ('11000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'other@example.test', '', now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"name":"Other"}');

insert into public.schools (id, name, status)
values ('21000000-0000-0000-0000-000000000001', 'Invitation School', 'active');
insert into public.memberships (user_id, school_id, role)
values ('11000000-0000-0000-0000-000000000001', '21000000-0000-0000-0000-000000000001', 'admin');

set local role authenticated;
select set_config('request.jwt.claim.sub', '11000000-0000-0000-0000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"11000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select extensions.is(
  (public.register_school('Owner School')->>'name'),
  'Owner School',
  'A verified user can register a school'
);
select extensions.is(
  (select count(*)::integer
   from public.memberships m
   join public.schools s on s.id = m.school_id
   where m.user_id = auth.uid() and m.role = 'admin' and s.name = 'Owner School'),
  1,
  'School registration creates an admin membership'
);
select set_config(
  'test.invitation_token',
  (public.create_school_invitation('21000000-0000-0000-0000-000000000001', 'bursar@example.test', 'bursar')->>'token'),
  true
);
select extensions.ok(
  current_setting('test.invitation_token') ~ '^[0-9a-f]{64}$',
  'An invitation returns a high-entropy token for one-time delivery'
);

select set_config('request.jwt.claim.sub', '11000000-0000-0000-0000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"11000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
select extensions.throws_ok(
  $$select public.accept_school_invitation(current_setting('test.invitation_token'))$$,
  '42501', null,
  'An invitation cannot be accepted by another email address'
);
select extensions.is(
  (select count(*)::integer from public.memberships where user_id = auth.uid()),
  0,
  'A rejected invitation does not create a membership'
);

select set_config('request.jwt.claim.sub', '11000000-0000-0000-0000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"11000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select extensions.is(
  (public.accept_school_invitation(current_setting('test.invitation_token'))->>'role'),
  'bursar',
  'The invited, verified user accepts with the assigned role'
);
select extensions.is(
  (select count(*)::integer from public.memberships where user_id = auth.uid() and school_id = '21000000-0000-0000-0000-000000000001' and role = 'bursar'),
  1,
  'Accepting the invite creates membership only in the invited school'
);
select extensions.throws_ok(
  $$select public.accept_school_invitation(current_setting('test.invitation_token'))$$,
  '22023', null,
  'An invitation token cannot be replayed'
);

select * from extensions.finish();
rollback;
