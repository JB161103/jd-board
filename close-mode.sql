-- =====================================================================
--  임시 공개 모드 끄기 : 다시 '본인만 수정, 방문자는 읽기 전용'으로
--  (Supabase → SQL Editor 에 붙여넣고 Run)
-- =====================================================================

drop policy if exists "임시공개 공고" on public.postings;
drop policy if exists "임시공개 비공개정보" on public.posting_private;
drop policy if exists "임시공개 설정" on public.owner_settings;
drop policy if exists "임시공개 캡처" on storage.objects;

revoke insert, update, delete on public.postings from anon;
revoke select, insert, update, delete on public.posting_private from anon;
revoke select, insert, update, delete on public.owner_settings from anon;
grant select on public.postings to anon;
