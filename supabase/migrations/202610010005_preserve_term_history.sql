create or replace function public.transfer_old_balance_on_carry_forward()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  prior_balance numeric(12, 2);
begin
  if new.type <> 'carry_forward' then
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
      new.term_id,
      -prior_balance,
      'adjustment',
      'rollover:transfer:' || new.term_id::text || ':' || new.student_id::text,
      auth.uid()
    ) on conflict (school_id, source_key) do nothing;
  end if;

  return new;
end;
$$;
