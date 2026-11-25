-- =====================================================================
--  임시 공개 모드 켜기 : 로그인 없이 누구나 공고 추가·수정·삭제 가능
--  (Supabase → SQL Editor 에 붙여넣고 Run)
--  ※ 이 상태에서는 Gemini API 키도 방문자가 읽을 수 있습니다.
--    제출이 끝나면 close-mode.sql 로 꼭 닫으세요.
-- =====================================================================

grant select, insert, update, delete on public.postings to anon;
grant select, insert, update, delete on public.posting_private to anon;
grant select, insert, update, delete on public.owner_settings to anon;

drop policy if exists "임시공개 공고" on public.postings;
create policy "임시공개 공고" on public.postings for all to anon using (true) with check (true);

drop policy if exists "임시공개 비공개정보" on public.posting_private;
create policy "임시공개 비공개정보" on public.posting_private for all to anon using (true) with check (true);

drop policy if exists "임시공개 설정" on public.owner_settings;
create policy "임시공개 설정" on public.owner_settings for select to anon using (true);

drop policy if exists "임시공개 캡처" on storage.objects;
create policy "임시공개 캡처" on storage.objects for all to anon
  using (bucket_id = 'jd-images') with check (bucket_id = 'jd-images');
