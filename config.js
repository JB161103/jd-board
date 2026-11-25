// =====================================================================
//  사이트 설정 파일 — 처음 한 번만 채우면 됩니다.
//  (가이드 3단계: Supabase 대시보드 → Project Settings → API Keys 에서 복사)
//
//  두 칸이 비어 있으면 사이트는 "데모 모드"로 열립니다.
//  (예시 공고가 보이고, 저장은 되지 않습니다)
// =====================================================================
window.APP_CONFIG = {
  // Project URL  (예: "https://abcdefghijk.supabase.co")
  SUPABASE_URL: "https://vmzozutrxectyxjjhjda.supabase.co",

  // Publishable key (sb_publishable_... 로 시작)
  // 예전 프로젝트라면 anon public 키(eyJ... 로 시작)를 넣어도 됩니다.
  // 공개돼도 괜찮은 키입니다. 데이터 보호는 데이터베이스 규칙(RLS)이 맡습니다.
  // ※ secret 키(sb_secret_...)나 service_role 키는 절대 넣지 마세요.
  SUPABASE_ANON_KEY: "sb_publishable_Mnm8CVj41_676R9AQwkFdw_jPC3OQXT",

  // 사이트 상단과 브라우저 탭에 보이는 이름
  SITE_TITLE: "JD 보드",

  // 임시 공개 모드: true 이면 로그인 없이 누구나 추가·수정 가능
  // (Supabase에서 open-mode.sql 도 실행해야 실제로 저장됩니다)
  // 다시 닫을 때: false 로 바꾸고 close-mode.sql 실행
  OPEN_MODE: true,
};
