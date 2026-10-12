create or replace function public.create_school_invitation(
  target_school_id uuid,
  invite_email text,
  invite_role text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  raw_token text;
  invitation_row public.invitations;
  normalized_email text := lower(trim(invite_email));
begin
  if caller_id is null or not public.has_school_role(target_school_id, array['admin']) then
    raise exception using errcode = '42501', message = 'Admin access required for this school.';
  end if;
  if invite_role not in ('admin', 'bursar') then
    raise exception using errcode = '22023', message = 'Choose admin or bursar.';
  end if;
  if normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception using errcode = '22023', message = 'Enter a valid email address.';
  end if;
  if not exists (
    select 1 from public.schools s
    where s.id = target_school_id and s.status in ('trial', 'active')
  ) then
    raise exception using errcode = '42501', message = 'This school is not accepting invitations.';
  end if;

  raw_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into public.invitations (
    school_id, email, role, token_hash, expires_at, created_by
  ) values (
    target_school_id,
    normalized_email,
    invite_role,
    encode(sha256(convert_to(raw_token, 'UTF8')), 'hex'),
    now() + interval '7 days',
    caller_id
  ) returning * into invitation_row;

  insert into public.audit_log (school_id, user_id, action, entity, entity_id, after)
  values (
    target_school_id,
    caller_id,
    'membership.invited',
    'invitation',
    invitation_row.id,
    jsonb_build_object('email', normalized_email, 'role', invite_role, 'expires_at', invitation_row.expires_at)
  );

  return jsonb_build_object(
    'invitation_id', invitation_row.id,
    'email', invitation_row.email,
    'role', invitation_row.role,
    'expires_at', invitation_row.expires_at,
    'token', raw_token
  );
end;
$$;

create or replace function public.accept_school_invitation(invitation_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  caller_email text;
  invitation_row public.invitations;
  school_name text;
begin
  if caller_id is null then
    raise exception using errcode = '42501', message = 'Sign in first.';
  end if;

  select lower(u.email) into caller_email
  from auth.users u
  join public.users p on p.id = u.id
  where u.id = caller_id and u.email_confirmed_at is not null and p.active;
  if caller_email is null then
    raise exception using errcode = '42501', message = 'Verify your email before accepting an invitation.';
  end if;

  select i.* into invitation_row
  from public.invitations i
  where i.token_hash = encode(sha256(convert_to(invitation_token, 'UTF8')), 'hex')
  for update;
  if not found or invitation_row.accepted_at is not null or invitation_row.expires_at <= now() then
    raise exception using errcode = '22023', message = 'This invitation is invalid or expired.';
  end if;
  if caller_email <> lower(invitation_row.email) then
    raise exception using errcode = '42501', message = 'Sign in with the email address this invitation was sent to.';
  end if;

  insert into public.memberships (user_id, school_id, role, active)
  values (caller_id, invitation_row.school_id, invitation_row.role, true)
  on conflict (user_id, school_id) do update
    set role = excluded.role, active = true;

  update public.invitations
  set accepted_at = now()
  where id = invitation_row.id;

  select s.name into school_name
  from public.schools s
  where s.id = invitation_row.school_id;

  insert into public.audit_log (school_id, user_id, action, entity, entity_id, after)
  values (
    invitation_row.school_id,
    caller_id,
    'membership.invitation_accepted',
    'membership',
    invitation_row.id,
    jsonb_build_object('role', invitation_row.role)
  );

  return jsonb_build_object(
    'school_id', invitation_row.school_id,
    'school_name', school_name,
    'role', invitation_row.role
  );
end;
$$;

grant execute on function public.create_school_invitation(uuid, text, text) to authenticated;
grant execute on function public.accept_school_invitation(text) to authenticated;
revoke all on function public.create_school_invitation(uuid, text, text) from public, anon;
revoke all on function public.accept_school_invitation(text) from public, anon;
