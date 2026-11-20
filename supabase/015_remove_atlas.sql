-- Savepoint Atlas shut down (2026-11-20, owner's decision: unrelated to Sogilex's restaurant tools). Safe to re-run.
-- Its data was test entries only (placeholder checklist items, no friends, no handles, no submitted entries).
-- Removes only Atlas's own pieces; nothing in Build, Menus or Flyers uses them (checked against code and database).
-- The sign-up hook goes first: it wrote an Atlas profile for every new Sogilex account, so new sign-ups would fail
-- once the profiles table is gone.
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();

drop function if exists public.friend_progress(text);
drop function if exists public.my_friends();
drop function if exists public.send_friend_request(text);
drop function if exists public.respond_friend_request(uuid, boolean);

drop table if exists public.checklist_items;
drop table if exists public.pack_entries;
drop function if exists public.limit_pending_entries();
drop table if exists public.friendships;
drop table if exists public.profiles;
drop table if exists public.admins;
drop function if exists public.is_admin();
