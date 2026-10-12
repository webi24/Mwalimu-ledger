create extension if not exists pgcrypto;

create table public.schools (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 120),
  status text not null default 'trial' check (status in ('trial', 'active', 'suspended')),
  trial_ends_at timestamptz not null default (now() + interval '30 days'),
  last_active_at timestamptz,
  created_at timestamptz not null default now(),
  unique (id)
);

create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null default '',
  email text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index users_email_lower_key on public.users (lower(email));

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  school_id uuid not null references public.schools(id) on delete cascade,
  role text not null check (role in ('admin', 'bursar')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (user_id, school_id),
  unique (id, school_id)
);

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  email text not null,
  role text not null check (role in ('admin', 'bursar')),
  token_hash text not null unique,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_by uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  unique (id, school_id)
);

create table public.platform_admins (
  user_id uuid primary key references public.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.classes (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 80),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, school_id),
  unique (school_id, name)
);

create table public.terms (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  year integer not null check (year between 2000 and 2200),
  term_number smallint not null check (term_number between 1 and 3),
  name text not null,
  due_date date,
  status text not null default 'open' check (status in ('open', 'closed')),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, school_id),
  unique (school_id, year, term_number)
);

create table public.fee_structures (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  term_id uuid not null,
  class_id uuid not null,
  amount numeric(12, 2) not null check (amount >= 0),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, school_id),
  unique (school_id, term_id, class_id),
  foreign key (term_id, school_id) references public.terms(id, school_id),
  foreign key (class_id, school_id) references public.classes(id, school_id)
);

create table public.students (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  admission_number text not null check (char_length(trim(admission_number)) between 1 and 40),
  name text not null check (char_length(trim(name)) between 1 and 160),
  class_id uuid not null,
  guardian_name text not null check (char_length(trim(guardian_name)) between 1 and 160),
  guardian_phone text not null check (char_length(trim(guardian_phone)) between 7 and 32),
  status text not null default 'active' check (status in ('active', 'inactive')),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, school_id),
  foreign key (class_id, school_id) references public.classes(id, school_id)
);

create unique index students_admission_number_per_school
  on public.students (school_id, lower(admission_number));

create table public.student_charges (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  student_id uuid not null,
  term_id uuid not null,
  amount numeric(12, 2) not null check (amount <> 0),
  type text not null check (type in ('fee', 'carry_forward', 'adjustment')),
  source_key text not null,
  created_at timestamptz not null default now(),
  created_by uuid references public.users(id),
  unique (id, school_id),
  unique (school_id, source_key),
  foreign key (student_id, school_id) references public.students(id, school_id),
  foreign key (term_id, school_id) references public.terms(id, school_id)
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  student_id uuid not null,
  term_id uuid not null,
  amount numeric(12, 2) not null check (amount > 0),
  method text not null check (method in ('cash', 'mpesa', 'bank')),
  mpesa_receipt text,
  reference text,
  paid_at timestamptz not null,
  source text not null default 'manual' check (source in ('manual', 'daraja_c2b')),
  recorded_by uuid references public.users(id),
  client_uuid uuid,
  voided_at timestamptz,
  void_reason text,
  created_at timestamptz not null default now(),
  unique (id, school_id),
  foreign key (student_id, school_id) references public.students(id, school_id),
  foreign key (term_id, school_id) references public.terms(id, school_id),
  check ((voided_at is null and void_reason is null) or (voided_at is not null and char_length(trim(void_reason)) > 0))
);

create unique index payments_client_uuid_per_school
  on public.payments (school_id, client_uuid)
  where client_uuid is not null;

create unique index payments_mpesa_receipt_per_school
  on public.payments (school_id, mpesa_receipt)
  where mpesa_receipt is not null;

create table public.unmatched_payments (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  mpesa_receipt text not null,
  amount numeric(12, 2) not null check (amount > 0),
  bill_ref text not null default '',
  paid_at timestamptz not null,
  raw_payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'assigned', 'refunded')),
  assigned_student_id uuid,
  created_at timestamptz not null default now(),
  unique (school_id, mpesa_receipt),
  foreign key (assigned_student_id, school_id) references public.students(id, school_id)
);

create table public.school_mpesa_config (
  school_id uuid primary key references public.schools(id) on delete cascade,
  shortcode text not null,
  type text not null check (type in ('paybill', 'till')),
  consumer_key_encrypted text not null,
  consumer_secret_encrypted text not null,
  callback_token_hash text not null unique,
  urls_registered_at timestamptz,
  environment text not null default 'sandbox' check (environment in ('sandbox', 'production')),
  updated_at timestamptz not null default now()
);

create table public.mpesa_callbacks_raw (
  id uuid primary key default gen_random_uuid(),
  school_id uuid references public.schools(id) on delete set null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processing_status text not null default 'received'
    check (processing_status in ('received', 'processing', 'processed', 'rejected', 'failed'))
);

create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  user_id uuid references public.users(id) on delete set null,
  action text not null,
  entity text not null,
  entity_id uuid,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);

create index memberships_user_active_idx on public.memberships (user_id, active);
create index memberships_school_active_idx on public.memberships (school_id, active);
create index students_school_class_status_idx on public.students (school_id, class_id, status);
create index terms_school_status_idx on public.terms (school_id, status, year, term_number);
create index charges_school_student_term_idx on public.student_charges (school_id, student_id, term_id);
create index payments_school_student_term_idx on public.payments (school_id, student_id, term_id);
create index audit_log_school_created_idx on public.audit_log (school_id, created_at desc);

create or replace function public.is_school_member(target_school_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    join public.users u on u.id = m.user_id
    where m.school_id = target_school_id
      and m.user_id = (select auth.uid())
      and m.active
      and u.active
  );
$$;

create or replace function public.has_school_role(target_school_id uuid, allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    join public.users u on u.id = m.user_id
    where m.school_id = target_school_id
      and m.user_id = (select auth.uid())
      and m.active
      and u.active
      and m.role = any (allowed_roles)
  );
$$;

create or replace function public.can_write_school(target_school_id uuid, allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.schools s
    where s.id = target_school_id
      and s.status in ('trial', 'active')
      and public.has_school_role(s.id, allowed_roles)
  );
$$;

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.platform_admins p
    where p.user_id = (select auth.uid())
  );
$$;

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.users (id, name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'name', ''),
    coalesce(new.email, '')
  )
  on conflict (id) do update
    set email = excluded.email,
        updated_at = now();
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

create or replace function public.register_school(school_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  confirmed_at timestamptz;
  created_school public.schools;
begin
  if caller_id is null then
    raise exception using errcode = '42501', message = 'Sign in first.';
  end if;

  select u.email_confirmed_at into confirmed_at
  from auth.users u
  where u.id = caller_id;

  if confirmed_at is null then
    raise exception using errcode = '42501', message = 'Verify your email before registering a school.';
  end if;

  if not exists (select 1 from public.users u where u.id = caller_id and u.active) then
    raise exception using errcode = '42501', message = 'This account is not active.';
  end if;

  insert into public.schools (name)
  values (trim(school_name))
  returning * into created_school;

  insert into public.memberships (user_id, school_id, role)
  values (caller_id, created_school.id, 'admin');

  insert into public.audit_log (school_id, user_id, action, entity, entity_id, after)
  values (
    created_school.id,
    caller_id,
    'school.registered',
    'school',
    created_school.id,
    jsonb_build_object('name', created_school.name, 'status', created_school.status)
  );

  return jsonb_build_object(
    'school_id', created_school.id,
    'name', created_school.name,
    'status', created_school.status,
    'trial_ends_at', created_school.trial_ends_at,
    'role', 'admin'
  );
end;
$$;

create or replace function public.get_my_schools()
returns table (
  school_id uuid,
  name text,
  status text,
  trial_ends_at timestamptz,
  role text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select s.id, s.name, s.status, s.trial_ends_at, m.role
  from public.schools s
  join public.memberships m on m.school_id = s.id
  where m.user_id = (select auth.uid())
    and m.active
  order by s.name;
$$;

create or replace function public.void_payment(payment_id uuid, reason text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  payment_row public.payments;
begin
  select * into payment_row
  from public.payments p
  where p.id = payment_id and public.has_school_role(p.school_id, array['admin']);

  if not found then
    raise exception using errcode = '42501', message = 'Payment not found or admin access required.';
  end if;
  if payment_row.voided_at is not null then
    return false;
  end if;
  if char_length(trim(reason)) < 3 then
    raise exception using errcode = '22023', message = 'A reason is required to void a payment.';
  end if;

  update public.payments
  set voided_at = now(), void_reason = trim(reason)
  where id = payment_row.id;

  insert into public.audit_log (school_id, user_id, action, entity, entity_id, before, after)
  values (
    payment_row.school_id,
    auth.uid(),
    'payment.voided',
    'payment',
    payment_row.id,
    jsonb_build_object('amount', payment_row.amount, 'receipt', payment_row.mpesa_receipt),
    jsonb_build_object('void_reason', trim(reason))
  );

  return true;
end;
$$;

create or replace function public.platform_school_metrics()
returns table (
  school_id uuid,
  name text,
  status text,
  trial_ends_at timestamptz,
  created_at timestamptz,
  last_active_at timestamptz,
  student_count bigint,
  payment_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_platform_admin() then
    raise exception using errcode = '42501', message = 'Platform admin access required.';
  end if;

  return query
  select
    s.id,
    s.name,
    s.status,
    s.trial_ends_at,
    s.created_at,
    s.last_active_at,
    (select count(*) from public.students st where st.school_id = s.id),
    (select count(*) from public.payments py where py.school_id = s.id)
  from public.schools s
  order by s.created_at desc;
end;
$$;

alter table public.schools enable row level security;
alter table public.users enable row level security;
alter table public.memberships enable row level security;
alter table public.invitations enable row level security;
alter table public.platform_admins enable row level security;
alter table public.classes enable row level security;
alter table public.terms enable row level security;
alter table public.fee_structures enable row level security;
alter table public.students enable row level security;
alter table public.student_charges enable row level security;
alter table public.payments enable row level security;
alter table public.unmatched_payments enable row level security;
alter table public.school_mpesa_config enable row level security;
alter table public.mpesa_callbacks_raw enable row level security;
alter table public.audit_log enable row level security;

create policy schools_member_read on public.schools
  for select to authenticated using (public.is_school_member(id));

create policy users_self_read on public.users
  for select to authenticated using (id = (select auth.uid()));
create policy users_self_update on public.users
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy memberships_self_or_admin_read on public.memberships
  for select to authenticated
  using (user_id = (select auth.uid()) or public.has_school_role(school_id, array['admin']));

create policy invitations_admin_read on public.invitations
  for select to authenticated using (public.has_school_role(school_id, array['admin']));

create policy platform_admin_self_read on public.platform_admins
  for select to authenticated using (user_id = (select auth.uid()));

create policy classes_member_read on public.classes
  for select to authenticated using (public.is_school_member(school_id));
create policy classes_admin_insert on public.classes
  for insert to authenticated with check (public.can_write_school(school_id, array['admin']));
create policy classes_admin_update on public.classes
  for update to authenticated
  using (public.can_write_school(school_id, array['admin']))
  with check (public.can_write_school(school_id, array['admin']));

create policy terms_member_read on public.terms
  for select to authenticated using (public.is_school_member(school_id));
create policy terms_admin_insert on public.terms
  for insert to authenticated with check (public.can_write_school(school_id, array['admin']));
create policy terms_admin_update on public.terms
  for update to authenticated
  using (public.can_write_school(school_id, array['admin']))
  with check (public.can_write_school(school_id, array['admin']));

create policy fee_structures_member_read on public.fee_structures
  for select to authenticated using (public.is_school_member(school_id));
create policy fee_structures_admin_insert on public.fee_structures
  for insert to authenticated with check (public.can_write_school(school_id, array['admin']));
create policy fee_structures_admin_update on public.fee_structures
  for update to authenticated
  using (public.can_write_school(school_id, array['admin']))
  with check (public.can_write_school(school_id, array['admin']));

create policy students_member_read on public.students
  for select to authenticated using (public.is_school_member(school_id));
create policy students_staff_insert on public.students
  for insert to authenticated with check (public.can_write_school(school_id, array['admin', 'bursar']));
create policy students_staff_update on public.students
  for update to authenticated
  using (public.can_write_school(school_id, array['admin', 'bursar']))
  with check (public.can_write_school(school_id, array['admin', 'bursar']));

create policy charges_member_read on public.student_charges
  for select to authenticated using (public.is_school_member(school_id));

create policy payments_member_read on public.payments
  for select to authenticated using (public.is_school_member(school_id));
create policy payments_staff_manual_insert on public.payments
  for insert to authenticated
  with check (
    public.can_write_school(school_id, array['admin', 'bursar'])
    and source = 'manual'
    and recorded_by = (select auth.uid())
    and voided_at is null
    and void_reason is null
  );

create policy unmatched_staff_read on public.unmatched_payments
  for select to authenticated
  using (public.has_school_role(school_id, array['admin', 'bursar']));

create policy audit_admin_read on public.audit_log
  for select to authenticated using (public.has_school_role(school_id, array['admin']));

revoke all on all tables in schema public from anon, authenticated;
revoke all on public.school_mpesa_config, public.mpesa_callbacks_raw from anon, authenticated;

grant select on public.schools, public.memberships, public.platform_admins,
  public.classes, public.terms, public.fee_structures, public.students,
  public.student_charges, public.payments, public.unmatched_payments,
  public.audit_log to authenticated;
grant select, update (name) on public.users to authenticated;
grant select on public.invitations to authenticated;
grant insert, update on public.classes, public.terms, public.fee_structures to authenticated;
grant insert, update on public.students to authenticated;
grant insert on public.payments to authenticated;

grant execute on function public.is_school_member(uuid) to authenticated;
grant execute on function public.has_school_role(uuid, text[]) to authenticated;
grant execute on function public.can_write_school(uuid, text[]) to authenticated;
grant execute on function public.register_school(text) to authenticated;
grant execute on function public.get_my_schools() to authenticated;
grant execute on function public.void_payment(uuid, text) to authenticated;
grant execute on function public.platform_school_metrics() to authenticated;

revoke all on function public.register_school(text) from public, anon;
revoke all on function public.void_payment(uuid, text) from public, anon;
revoke all on function public.platform_school_metrics() from public, anon;
