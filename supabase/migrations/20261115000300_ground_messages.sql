-- =============================================================================
-- OMNI ambient health monitoring: messages from Mission Control (crew inbox)
--
-- ground_messages      written aboard only by the relay (role omni_relay) when
--                      Earth traffic arrives; crew never author or edit them.
-- ground_message_reads one row per crew member who has read a message, so a
--                      message to all crew has its own read state per person.
--
-- Visibility: a message addressed to one crew member is visible to that member
-- and to medical oversight (flight surgeon, commander); a message with no
-- recipient is for all crew. Reads are stamped server-side: a crew member can
-- only mark their own read, only for a message they can see, and only once.
-- =============================================================================

create type public.message_priority as enum ('routine', 'urgent');

create table public.ground_messages (
  id                uuid primary key default gen_random_uuid(),
  author            text not null check (char_length(author) between 1 and 80),
  priority          public.message_priority not null default 'routine',
  recipient_crew_id uuid references public.crew_members (id) on delete restrict,
  subject           text not null check (char_length(subject) between 1 and 120),
  body              text not null check (char_length(body) between 1 and 4000),
  sent_at           timestamptz not null,
  received_at       timestamptz not null default clock_timestamp()
);

create table public.ground_message_reads (
  message_id     uuid not null references public.ground_messages (id) on delete cascade,
  crew_member_id uuid not null references public.crew_members (id) on delete restrict,
  read_at        timestamptz not null default clock_timestamp(),
  primary key (message_id, crew_member_id)
);

create index ground_messages_received_idx on public.ground_messages (received_at desc);
create index ground_messages_recipient_idx on public.ground_messages (recipient_crew_id);
create index ground_message_reads_member_idx on public.ground_message_reads (crew_member_id);

create or replace function omni_private.can_see_message(p_recipient uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_recipient is null
      or p_recipient = omni_private.current_crew_member_id()
      or omni_private.has_medical_oversight();
$$;

-- Reads are always "me, now": whatever the client sends is overwritten.
create or replace function omni_private.tg_message_read_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.crew_member_id := omni_private.current_crew_member_id();
  new.read_at := clock_timestamp();
  if new.crew_member_id is null then
    raise exception 'No active crew identity for this session' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger t10_read_stamp before insert on public.ground_message_reads
  for each row execute function omni_private.tg_message_read_stamp();

alter table public.ground_messages enable row level security;
alter table public.ground_message_reads enable row level security;

revoke all on public.ground_messages, public.ground_message_reads from anon, authenticated, public;
grant select on public.ground_messages to authenticated;
grant select, insert on public.ground_message_reads to authenticated;
-- The relay reads back what it stored to confirm delivery to Earth.
grant select, insert on public.ground_messages to omni_relay;
grant execute on function omni_private.can_see_message(uuid) to authenticated;

create policy ground_messages_select on public.ground_messages
  for select to authenticated
  using (omni_private.can_see_message(recipient_crew_id));

create policy ground_messages_relay on public.ground_messages
  for all to omni_relay
  using (true) with check (true);

-- Oversight sees who has read what; crew see their own reads.
create policy ground_message_reads_select on public.ground_message_reads
  for select to authenticated
  using (crew_member_id = omni_private.current_crew_member_id() or omni_private.has_medical_oversight());

create policy ground_message_reads_insert on public.ground_message_reads
  for insert to authenticated
  with check (
    crew_member_id = omni_private.current_crew_member_id()
    and exists (
      select 1 from public.ground_messages m
       where m.id = message_id and omni_private.can_see_message(m.recipient_crew_id)
    )
  );
