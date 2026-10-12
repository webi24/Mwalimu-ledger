create or replace function public.transfer_old_balance_on_carry_forward()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  prior_term_id uuid;
  prior_balance numeric(12, 2);
begin
  if new.type <> 'carry_forward' then
    return new;
  end if;

  select t.id into prior_term_id
  from public.terms t
  join public.terms current_term
    on current_term.id = new.term_id and current_term.school_id = new.school_id
  where t.school_id = new.school_id
    and (t.year, t.term_number) < (current_term.year, current_term.term_number)
  order by t.year desc, t.term_number desc
  limit 1;

  if prior_term_id is null then
    return new;
  end if;

  select coalesce(sum(ch.amount), 0) - coalesce((
    select sum(p.amount)
    from public.payments p
    join public.terms payment_term
      on payment_term.id = p.term_id and payment_term.school_id = p.school_id
    join public.terms current_term
      on current_term.id = new.term_id and current_term.school_id = new.school_id
    where p.school_id = new.school_id
      and p.student_id = new.student_id
      and p.voided_at is null
      and (payment_term.year, payment_term.term_number) < (current_term.year, current_term.term_number)
  ), 0)
  into prior_balance
  from public.student_charges ch
  join public.terms charge_term
    on charge_term.id = ch.term_id and charge_term.school_id = ch.school_id
  join public.terms current_term
    on current_term.id = new.term_id and current_term.school_id = new.school_id
  where ch.school_id = new.school_id
    and ch.student_id = new.student_id
    and (charge_term.year, charge_term.term_number) < (current_term.year, current_term.term_number);

  if prior_balance <> 0 then
    insert into public.student_charges (
      school_id, student_id, term_id, amount, type, source_key, created_by
    ) values (
      new.school_id,
      new.student_id,
      prior_term_id,
      -prior_balance,
      'adjustment',
      'rollover:transfer:' || new.term_id::text || ':' || new.student_id::text,
      auth.uid()
    ) on conflict (school_id, source_key) do nothing;
  end if;

  return new;
end;
$$;

create trigger carry_forward_transfer_out
  after insert on public.student_charges
  for each row
  when (new.type = 'carry_forward')
  execute function public.transfer_old_balance_on_carry_forward();

create or replace function public.get_school_balances(target_school_id uuid, target_term_id uuid)
returns table (
  student_id uuid,
  balance numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  target_term public.terms;
begin
  if auth.uid() is null or not public.is_school_member(target_school_id) then
    raise exception using errcode = '42501', message = 'School membership required.';
  end if;

  select * into target_term
  from public.terms t
  where t.id = target_term_id and t.school_id = target_school_id;
  if not found then
    raise exception using errcode = '22023', message = 'Term does not belong to this school.';
  end if;

  return query
  select
    st.id,
    coalesce((
      select sum(ch.amount)
      from public.student_charges ch
      join public.terms charge_term
        on charge_term.id = ch.term_id and charge_term.school_id = ch.school_id
      where ch.school_id = target_school_id
        and ch.student_id = st.id
        and (charge_term.year, charge_term.term_number) <= (target_term.year, target_term.term_number)
    ), 0) - coalesce((
      select sum(p.amount)
      from public.payments p
      join public.terms payment_term
        on payment_term.id = p.term_id and payment_term.school_id = p.school_id
      where p.school_id = target_school_id
        and p.student_id = st.id
        and p.voided_at is null
        and (payment_term.year, payment_term.term_number) <= (target_term.year, target_term.term_number)
    ), 0)
  from public.students st
  where st.school_id = target_school_id and st.status = 'active';
end;
$$;

grant execute on function public.get_school_balances(uuid, uuid) to authenticated;
revoke all on function public.get_school_balances(uuid, uuid) from public, anon;
