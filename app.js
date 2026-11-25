// =====================================================================
//  JD 보드 — 사이트 동작 코드
//  자주 고칠 만한 곳:
//   · FIELDS   : 정리 항목(이름·순서·필수 여부)
//   · STATUSES : 지원 상태 목록
//   · AI_PROMPT: AI에게 주는 지시문
// =====================================================================

const CFG = window.APP_CONFIG || {};
const DEMO = !CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY;
const OPEN = !DEMO && CFG.OPEN_MODE === true; // 임시 공개 모드 (config.js)
const params = new URLSearchParams(location.search);
const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const BUCKET = "jd-images";

const STATUSES = ["검토 중", "지원 예정", "지원 완료", "포기"];

// 정리 항목 12개. memo 는 본인만 보이는 칸입니다.
const FIELDS = [
  { key: "company", label: "회사명", required: true },
  { key: "title", label: "직무명", required: true },
  // 마감일은 아래에서 별도 상자로 그립니다 (deadline, deadline_time, rolling)
  { key: "requirements", label: "지원자격", required: true, multiline: true, full: true },
  { key: "preferred", label: "우대조건", multiline: true, full: true },
  { key: "duties", label: "주요 업무", multiline: true, full: true },
  { key: "location", label: "근무지" },
  { key: "employment_type", label: "고용형태" },
  { key: "process", label: "전형절차", full: true },
  { key: "documents", label: "제출서류", multiline: true },
  { key: "apply_via", label: "지원처" },
  { key: "memo", label: "메모", multiline: true, full: true, private: true },
];

// AI에게 주는 지시문
const AI_PROMPT = (today) => `다음 이미지는 한국 채용공고(JD) 캡처입니다. 여러 장이면 하나의 공고가 이어진 것입니다.
공고에 적힌 내용만 뽑아 JSON으로 정리하세요. 공고에 없는 항목은 빈 문자열("")로 두고 절대 추측하지 마세요.
오늘 날짜는 ${today} 입니다.

- company: 회사명
- title: 모집 직무명 (여러 직무면 " / "로 구분)
- deadline: 접수 마감일, YYYY-MM-DD 형식. 연도가 없으면 오늘 이후 가장 가까운 날짜로. 상시채용이면 "".
- deadline_time: 마감 시간 HH:MM (없으면 "")
- rolling: 상시채용이거나 "채용 시 마감"이면 true, 아니면 false
- requirements: 필수 지원자격 (학력·전공·경력·자격증 등). 항목마다 "- "로 시작하는 줄로.
- preferred: 우대사항. 항목마다 "- "로 시작하는 줄로.
- duties: 주요 업무 요약. 항목마다 "- "로 시작하는 줄로.
- location: 근무지
- employment_type: 고용형태 (정규직/계약직/인턴 등)
- process: 전형절차를 "서류 → 1차 면접 → ..." 형태로
- documents: 제출서류와 자기소개서 문항 수
- apply_via: 지원 방법·사이트 (예: 사람인 즉시지원, 회사 홈페이지)`;

const AI_SCHEMA = {
  type: "OBJECT",
  properties: {
    company: { type: "STRING" }, title: { type: "STRING" },
    deadline: { type: "STRING" }, deadline_time: { type: "STRING" }, rolling: { type: "BOOLEAN" },
    requirements: { type: "STRING" }, preferred: { type: "STRING" }, duties: { type: "STRING" },
    location: { type: "STRING" }, employment_type: { type: "STRING" }, process: { type: "STRING" },
    documents: { type: "STRING" }, apply_via: { type: "STRING" },
  },
  required: ["company", "title", "deadline", "rolling", "requirements"],
};

// ---------------------------------------------------------------------
//  상태
// ---------------------------------------------------------------------
let sb = null; // Supabase 연결
const state = {
  postings: [],
  priv: {},          // posting_id → { memo, image_paths }
  owner: false,
  settings: { gemini_key: "", model: DEFAULT_MODEL },
  pending: [],       // 업로드 대기 이미지 [{ blob, url }]
  editingId: null,
};

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------------------------------------------------------------------
//  날짜 (한국 시간 기준)
// ---------------------------------------------------------------------
function todayKST() { return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); }
function daysLeft(date) { return Math.round((Date.parse(date) - Date.parse(todayKST())) / 864e5); }
function isPast(p) { return !p.rolling && p.deadline && daysLeft(p.deadline) < 0; }
function fmtDate(d) {
  if (!d) return "";
  const [y, m, day] = d.split("-").map(Number);
  const wd = "일월화수목금토"[new Date(Date.UTC(y, m - 1, day)).getUTCDay()];
  return `${m}/${day}(${wd})`;
}
function ddayBadge(p) {
  if (p.rolling) return `<span class="dday rolling">상시</span>`;
  if (!p.deadline) return `<span class="dday past">미정</span>`;
  const n = daysLeft(p.deadline);
  if (n < 0) return `<span class="dday past">마감</span>`;
  const cls = n <= 3 ? "urgent" : n <= 7 ? "soon" : "";
  return `<span class="dday ${cls}">${n === 0 ? "D-day" : "D-" + n}</span>`;
}
function sortPostings(list) {
  const rank = (p) => (isPast(p) ? 2 : p.rolling || !p.deadline ? 1 : 0);
  return [...list].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r) return r;
    if (rank(a) === 0) return a.deadline.localeCompare(b.deadline);
    if (rank(a) === 2) return b.deadline.localeCompare(a.deadline);
    return (b.created_at || "").localeCompare(a.created_at || "");
  });
}

// ---------------------------------------------------------------------
//  화면 그리기
// ---------------------------------------------------------------------
function render() {
  document.body.classList.toggle("is-owner", state.owner);
  const q = $("#search").value.trim().toLowerCase();
  const st = $("#statusFilter").value;
  const hidePast = $("#hidePast").checked;

  const all = sortPostings(state.postings);
  const shown = all.filter((p) => {
    if (st !== "all" && p.status !== st) return false;
    if (hidePast && isPast(p)) return false;
    if (!q) return true;
    return [p.company, p.title, p.requirements, p.preferred, p.duties, p.location].join(" ").toLowerCase().includes(q);
  });

  // 요약
  const active = all.filter((p) => !isPast(p) && p.status !== "포기");
  const week = active.filter((p) => !p.rolling && p.deadline && daysLeft(p.deadline) <= 7);
  const done = all.filter((p) => p.status === "지원 완료");
  $("#summary").innerHTML = `
    <div class="stat"><div class="num">${all.length}</div><div class="lbl">전체 공고</div></div>
    <div class="stat"><div class="num">${active.length}</div><div class="lbl">진행 중</div></div>
    <div class="stat urgent"><div class="num">${week.length}</div><div class="lbl">7일 내 마감</div></div>
    <div class="stat ok"><div class="num">${done.length}</div><div class="lbl">지원 완료</div></div>`;

  // PC 표
  $("#tableBody").innerHTML = shown.map((p) => `
    <tr data-id="${p.id}" class="${isPast(p) ? "past" : ""}">
      <td><div class="deadline-cell">${ddayBadge(p)}<span class="date">${p.rolling ? "채용 시 마감" : fmtDate(p.deadline)}${p.deadline_time ? " " + esc(p.deadline_time) : ""}</span></div></td>
      <td class="company">${esc(p.company)}</td>
      <td>${esc(p.title)}</td>
      <td>${esc(p.location)}</td>
      <td>${esc(p.employment_type)}</td>
      <td><span class="status" data-s="${esc(p.status)}">${esc(p.status)}</span></td>
    </tr>`).join("");

  // 휴대폰 카드
  $("#cards").innerHTML = shown.map((p) => `
    <article class="card ${isPast(p) ? "past" : ""}" data-id="${p.id}">
      <div class="card-top">${ddayBadge(p)}<span class="status" data-s="${esc(p.status)}">${esc(p.status)}</span></div>
      <div class="company">${esc(p.company)}</div>
      <div class="title">${esc(p.title)}</div>
      <div class="meta">
        <span>마감 ${p.rolling ? "채용 시" : fmtDate(p.deadline)}${p.deadline_time ? " " + esc(p.deadline_time) : ""}</span>
        ${p.location ? `<span>${esc(p.location)}</span>` : ""}
        ${p.employment_type ? `<span>${esc(p.employment_type)}</span>` : ""}
      </div>
    </article>`).join("");

  $("#empty").hidden = shown.length > 0;
}

// ---------------------------------------------------------------------
//  공고 상세
// ---------------------------------------------------------------------
async function openDetail(id) {
  const p = state.postings.find((x) => x.id === id);
  if (!p) return;
  $("#detailTitle").textContent = `${p.company} · ${p.title}`;
  const rows = FIELDS.filter((f) => !f.private && !["company", "title"].includes(f.key))
    .map((f) => `<dt>${f.label}</dt><dd>${esc(p[f.key]) || "<span class='hint'>-</span>"}</dd>`).join("");
  const deadlineText = p.rolling ? "상시채용 (채용 시 마감)" : p.deadline ? `${p.deadline} ${fmtDate(p.deadline).slice(-3)} ${p.deadline_time || ""}` : "미정";

  let privateHtml = "";
  if (state.owner) {
    const pr = state.priv[p.id] || {};
    const urls = await imageUrls(pr.image_paths || []);
    privateHtml = `
      <div class="private-box">
        <h3>본인만 보이는 정보</h3>
        <dl class="detail-grid"><dt>메모</dt><dd>${esc(pr.memo) || "<span class='hint'>-</span>"}</dd></dl>
        <div class="imgs" style="margin-top:10px">${urls.map((u) => `<a href="${u}" target="_blank" rel="noopener"><img src="${u}" alt="원본 캡처"></a>`).join("") || "<span class='hint'>원본 캡처 없음</span>"}</div>
      </div>
      <div class="detail-actions">
        <button class="btn danger" id="btnDelete" type="button">삭제</button>
        <button class="btn" id="btnEdit" type="button">수정</button>
      </div>`;
  }

  $("#detailBody").innerHTML = `
    <div class="detail-top">
      ${ddayBadge(p)}
      ${state.owner
        ? `<select id="statusSel">${STATUSES.map((s) => `<option ${s === p.status ? "selected" : ""}>${s}</option>`).join("")}</select>`
        : `<span class="status" data-s="${esc(p.status)}">${esc(p.status)}</span>`}
    </div>
    <dl class="detail-grid"><dt>마감일</dt><dd><b>${esc(deadlineText)}</b></dd>${rows}</dl>
    ${privateHtml}`;

  if (state.owner) {
    $("#statusSel").onchange = (e) => updateStatus(p.id, e.target.value);
    $("#btnEdit").onclick = async () => { $("#detailDlg").close(); openReview({ ...p, memo: state.priv[p.id]?.memo || "" }, await imageUrls(state.priv[p.id]?.image_paths || []), p.id); };
    $("#btnDelete").onclick = () => deletePosting(p.id);
  }
  $("#detailDlg").showModal();
}

// ---------------------------------------------------------------------
//  공고 추가: 이미지 받기
// ---------------------------------------------------------------------
function addImages(files) {
  for (const f of files) {
    if (!f.type.startsWith("image/")) continue;
    state.pending.push({ blob: f, url: URL.createObjectURL(f) });
  }
  renderThumbs();
}
function renderThumbs() {
  $("#thumbs").innerHTML = state.pending.map((x, i) => `<div class="thumb"><img src="${x.url}" alt=""><button type="button" data-rm="${i}">×</button></div>`).join("");
  $("#btnExtract").disabled = state.pending.length === 0;
  $("#uploadHint").textContent = state.pending.length
    ? `${state.pending.length}장 선택됨 — 한 공고로 묶어서 정리합니다.`
    : "긴 공고는 여러 장을 한 번에 올리면 한 공고로 묶입니다.";
}
function openUpload(files = []) {
  state.pending.forEach((x) => URL.revokeObjectURL(x.url));
  state.pending = [];
  addImages(files);
  $("#uploadDlg").showModal();
  $("#dropZone").focus();
}

// 이미지 크기 줄이기 (용량 절약 + AI 전송 속도)
async function shrink(blob, maxW = 1400) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, maxW / bmp.width);
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return await new Promise((r) => c.toBlob(r, "image/jpeg", 0.85));
}
const toBase64 = (blob) => new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result.split(",")[1]); fr.readAsDataURL(blob); });

// ---------------------------------------------------------------------
//  AI 추출 (Gemini)
// ---------------------------------------------------------------------
async function extract() {
  const btn = $("#btnExtract");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> 정리 중...`;
  try {
    const blobs = await Promise.all(state.pending.map((x) => shrink(x.blob)));
    let data;
    if (DEMO) {
      await new Promise((r) => setTimeout(r, 900));
      data = { ...SAMPLE_EXTRACT };
    } else {
      if (!state.settings.gemini_key) throw new Error("설정에서 Gemini API 키를 먼저 넣어 주세요.");
      data = await callGemini(blobs);
    }
    state.shrunk = blobs;
    $("#uploadDlg").close();
    openReview({ ...data, status: "검토 중", memo: "" }, state.pending.map((x) => x.url), null);
  } catch (e) {
    toast(e.message || "정리에 실패했습니다.");
  } finally {
    btn.disabled = state.pending.length === 0;
    btn.textContent = "AI로 정리하기";
  }
}

async function callGemini(blobs) {
  const model = state.settings.model || DEFAULT_MODEL;
  const parts = [{ text: AI_PROMPT(todayKST()) }];
  for (const b of blobs) parts.push({ inline_data: { mime_type: "image/jpeg", data: await toBase64(b) } });
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": state.settings.gemini_key },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: { responseMimeType: "application/json", responseSchema: AI_SCHEMA, temperature: 0 },
    }),
  });
  const json = await res.json();
  if (!res.ok) {
    const msg = json?.error?.message || res.statusText;
    if (res.status === 429) throw new Error("AI 무료 사용량을 잠시 초과했습니다. 1분 뒤 다시 시도하세요.");
    if (res.status === 404) throw new Error(`모델 이름(${model})을 찾을 수 없습니다. 설정에서 모델 이름을 확인하세요.`);
    throw new Error("AI 오류: " + msg);
  }
  const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "{}";
  return JSON.parse(text);
}

// ---------------------------------------------------------------------
//  확인·수정 화면
// ---------------------------------------------------------------------
function openReview(data, imgUrls, editingId) {
  state.editingId = editingId;
  $("#reviewTitle").textContent = editingId ? "공고 수정" : "내용 확인 후 저장";
  $("#reviewImages").innerHTML = imgUrls.length
    ? imgUrls.map((u) => `<img src="${u}" alt="원본 캡처">`).join("")
    : `<div class="noimg">원본 이미지 없음</div>`;

  const fieldHtml = (f) => {
    const v = esc(data[f.key] || "");
    const label = `<span>${f.label}${f.required ? `<em class="req">*</em>` : ""}${f.private ? `<i class="private">본인만 보임</i>` : ""}</span>`;
    const input = f.multiline ? `<textarea name="${f.key}">${v}</textarea>` : `<input name="${f.key}" value="${v}">`;
    return `<label class="field ${f.full ? "full" : ""}" data-key="${f.key}">${label}${input}</label>`;
  };

  const deadlineBox = `
    <div class="field deadline-box" data-key="deadline">
      <span>마감일<em class="req">*</em> — 원본과 꼭 대조하세요</span>
      <div class="deadline-row">
        <input type="date" name="deadline" value="${esc(data.deadline || "")}">
        <input type="text" name="deadline_time" placeholder="18:00" value="${esc(data.deadline_time || "")}">
        <label class="check"><input type="checkbox" name="rolling" ${data.rolling ? "checked" : ""}> 상시채용·채용 시 마감</label>
      </div>
    </div>`;

  const [company, title, ...rest] = FIELDS;
  $("#reviewForm").innerHTML = fieldHtml(company) + fieldHtml(title) + deadlineBox + rest.map(fieldHtml).join("") + `
    <label class="field"><span>지원 상태</span>
      <select name="status">${STATUSES.map((s) => `<option ${s === (data.status || "검토 중") ? "selected" : ""}>${s}</option>`).join("")}</select>
    </label>
    <div class="form-foot">
      <p class="error" id="reviewError"></p>
      <button type="button" class="btn ghost" data-close>취소</button>
      <button type="submit" class="btn primary" id="btnSave">저장</button>
    </div>`;
  markMissing();
  $("#reviewForm").oninput = markMissing;
  $("#reviewDlg").showModal();
}

function readForm() {
  const fd = new FormData($("#reviewForm"));
  const o = {};
  for (const f of FIELDS) o[f.key] = (fd.get(f.key) || "").toString().trim();
  o.deadline = (fd.get("deadline") || "").toString() || null;
  o.deadline_time = (fd.get("deadline_time") || "").toString().trim();
  o.rolling = fd.get("rolling") === "on";
  o.status = fd.get("status") || "검토 중";
  return o;
}
function missingKeys(o) {
  const m = FIELDS.filter((f) => f.required && !o[f.key]).map((f) => f.key);
  if (!o.rolling && !o.deadline) m.push("deadline");
  return m;
}
function markMissing() {
  const m = missingKeys(readForm());
  document.querySelectorAll("#reviewForm .field").forEach((el) => el.classList.toggle("missing", m.includes(el.dataset.key)));
  const names = m.map((k) => (k === "deadline" ? "마감일" : FIELDS.find((f) => f.key === k).label));
  $("#reviewError").textContent = names.length ? `비어 있는 필수 항목: ${names.join(", ")}` : "";
}

async function save(e) {
  e.preventDefault();
  const o = readForm();
  if (missingKeys(o).length) {
    if (!confirm("필수 항목이 비어 있습니다. 그래도 저장할까요?")) return;
  }
  const { memo, ...pub } = o;
  const btn = $("#btnSave");
  btn.disabled = true;
  btn.textContent = "저장 중...";
  try {
    if (DEMO) {
      const id = state.editingId || "demo-" + Date.now();
      const old = state.postings.find((p) => p.id === id);
      const row = { ...old, ...pub, id, created_at: old?.created_at || new Date().toISOString() };
      state.postings = [...state.postings.filter((p) => p.id !== id), row];
      state.priv[id] = { ...(state.priv[id] || {}), memo };
    } else if (state.editingId) {
      const id = state.editingId;
      let r = await sb.from("postings").update(pub).eq("id", id);
      if (r.error) throw r.error;
      r = await sb.from("posting_private").upsert({ posting_id: id, memo });
      if (r.error) throw r.error;
    } else {
      const ins = await sb.from("postings").insert(pub).select().single();
      if (ins.error) throw ins.error;
      const id = ins.data.id;
      const paths = [];
      const blobs = state.shrunk || [];
      for (let i = 0; i < blobs.length; i++) {
        const path = `${id}/${i + 1}.jpg`;
        const up = await sb.storage.from(BUCKET).upload(path, blobs[i], { contentType: "image/jpeg", upsert: true });
        if (up.error) throw up.error;
        paths.push(path);
      }
      const r = await sb.from("posting_private").upsert({ posting_id: id, memo, image_paths: paths });
      if (r.error) throw r.error;
    }
    $("#reviewDlg").close();
    state.shrunk = null;
    await load();
    toast("저장했습니다.");
  } catch (err) {
    $("#reviewError").textContent = "저장 실패: " + (err.message || err);
  } finally {
    btn.disabled = false;
    btn.textContent = "저장";
  }
}

async function updateStatus(id, status) {
  if (DEMO) {
    state.postings.find((p) => p.id === id).status = status;
  } else {
    const r = await sb.from("postings").update({ status }).eq("id", id);
    if (r.error) return toast("변경 실패: " + r.error.message);
    state.postings.find((p) => p.id === id).status = status;
  }
  render();
  toast(`상태: ${status}`);
}

async function deletePosting(id) {
  const p = state.postings.find((x) => x.id === id);
  if (!confirm(`'${p.company} · ${p.title}' 공고를 삭제할까요? 되돌릴 수 없습니다.`)) return;
  if (!DEMO) {
    const paths = state.priv[id]?.image_paths || [];
    if (paths.length) await sb.storage.from(BUCKET).remove(paths);
    const r = await sb.from("postings").delete().eq("id", id);
    if (r.error) return toast("삭제 실패: " + r.error.message);
  }
  state.postings = state.postings.filter((x) => x.id !== id);
  delete state.priv[id];
  $("#detailDlg").close();
  render();
  toast("삭제했습니다.");
}

async function imageUrls(paths) {
  if (DEMO || !paths.length) return DEMO ? paths : [];
  const { data } = await sb.storage.from(BUCKET).createSignedUrls(paths, 3600);
  return (data || []).map((d) => d.signedUrl).filter(Boolean);
}

// ---------------------------------------------------------------------
//  데이터 불러오기
// ---------------------------------------------------------------------
async function load() {
  if (DEMO) { render(); return; }
  const { data, error } = await sb.from("postings").select("*");
  if (error) { toast("불러오기 실패: " + error.message); return; }
  state.postings = data;
  state.priv = {};
  if (state.owner) {
    const pr = await sb.from("posting_private").select("*");
    for (const r of pr.data || []) state.priv[r.posting_id] = r;
    const st = await sb.from("owner_settings").select("*").eq("id", 1).maybeSingle();
    if (st.data) state.settings = { gemini_key: st.data.gemini_key || "", model: st.data.model || DEFAULT_MODEL };
  }
  render();
}

// ---------------------------------------------------------------------
//  로그인·설정
// ---------------------------------------------------------------------
async function login(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  $("#loginError").textContent = "";
  if (DEMO) { state.owner = true; $("#loginDlg").close(); render(); afterLogin(); return; }
  const { error } = await sb.auth.signInWithPassword({ email: fd.get("email"), password: fd.get("password") });
  if (error) { $("#loginError").textContent = "이메일 또는 비밀번호가 맞지 않습니다."; return; }
  $("#loginDlg").close();
}
async function logout() {
  if (!DEMO) await sb.auth.signOut();
  state.owner = false;
  state.priv = {};
  render();
}
async function saveSettings(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const s = { gemini_key: fd.get("gemini_key").trim(), model: fd.get("model").trim() || DEFAULT_MODEL };
  if (!DEMO) {
    const r = await sb.from("owner_settings").upsert({ id: 1, ...s });
    if (r.error) return toast("저장 실패: " + r.error.message);
  }
  state.settings = s;
  $("#settingsDlg").close();
  toast("설정을 저장했습니다.");
}
function openSettings() {
  const f = $("#settingsForm");
  f.gemini_key.value = state.settings.gemini_key;
  f.model.value = state.settings.model;
  $("#settingsDlg").showModal();
}

// 휴대폰에서 '공유 → JD 보드'로 보낸 이미지 받기
async function afterLogin() {
  if (params.get("shared") !== "1" || !("caches" in window)) return;
  const c = await caches.open("share-target");
  const files = [];
  for (const req of await c.keys()) {
    const res = await c.match(req);
    const blob = await res.blob();
    files.push(new File([blob], decodeURIComponent(res.headers.get("x-name") || "shared.jpg"), { type: blob.type }));
    await c.delete(req);
  }
  history.replaceState(null, "", location.pathname);
  if (files.length) openUpload(files);
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2800);
}

// ---------------------------------------------------------------------
//  이벤트 연결
// ---------------------------------------------------------------------
function bind() {
  $("#search").oninput = render;
  $("#statusFilter").onchange = render;
  $("#hidePast").onchange = render;
  const openFromList = (e) => { const el = e.target.closest("[data-id]"); if (el) openDetail(el.dataset.id); };
  $("#tableBody").onclick = openFromList;
  $("#cards").onclick = openFromList;

  $("#btnLogin").onclick = () => $("#loginDlg").showModal();
  $("#btnLogout").onclick = logout;
  $("#btnAdd").onclick = () => openUpload();
  $("#btnSettings").onclick = openSettings;
  $("#loginForm").onsubmit = login;
  $("#settingsForm").onsubmit = saveSettings;
  $("#reviewForm").onsubmit = save;
  $("#btnExtract").onclick = extract;
  $("#btnManual").onclick = async () => {
    state.shrunk = await Promise.all(state.pending.map((x) => shrink(x.blob)));
    $("#uploadDlg").close();
    openReview({ status: "검토 중" }, state.pending.map((x) => x.url), null);
  };
  $("#fileInput").onchange = (e) => { addImages(e.target.files); e.target.value = ""; };
  $("#thumbs").onclick = (e) => { const i = e.target.dataset.rm; if (i !== undefined) { state.pending.splice(Number(i), 1); renderThumbs(); } };

  // 닫기 버튼
  document.addEventListener("click", (e) => { if (e.target.matches("[data-close]")) e.target.closest("dialog").close(); });

  // 끌어다 놓기
  const dz = $("#dropZone");
  dz.ondragover = (e) => { e.preventDefault(); dz.classList.add("over"); };
  dz.ondragleave = () => dz.classList.remove("over");
  dz.ondrop = (e) => { e.preventDefault(); dz.classList.remove("over"); addImages(e.dataTransfer.files); };

  // Ctrl+V 붙여넣기 (공고 추가 창이 열려 있지 않으면 자동으로 엶)
  document.addEventListener("paste", (e) => {
    if (!state.owner) return;
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    if (!$("#uploadDlg").open) openUpload(files); else addImages(files);
  });
}

// ---------------------------------------------------------------------
//  시작
// ---------------------------------------------------------------------
async function start() {
  document.title = CFG.SITE_TITLE || "JD 보드";
  $("#siteTitle").textContent = CFG.SITE_TITLE || "JD 보드";
  bind();

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  if (DEMO) {
    $("#demoBanner").hidden = params.has("clean");
    state.postings = SAMPLE_POSTINGS();
    state.priv = { s1: { memo: "연봉 협상 여지 있는지 확인. 지인 추천 가능.", image_paths: [] } };
    state.owner = params.get("owner") === "1";
    render();
    if (params.get("view") === "review") openReview({ ...SAMPLE_EXTRACT, status: "검토 중", memo: "" }, ["demo-jd.png"], null);
    if (params.get("view") === "upload") openUpload();
    if (params.get("view") === "detail") openDetail("s1");
    return;
  }

  const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm");
  sb = createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
  const { data } = await sb.auth.getSession();
  state.owner = OPEN || !!data.session;
  if (OPEN) {
    $("#btnLogout").hidden = true;
    $("#demoBanner").textContent = "과제 시연용 공개 모드입니다. 로그인 없이 누구나 공고를 추가·수정할 수 있습니다.";
    $("#demoBanner").hidden = false;
  }
  await load();
  if (state.owner) afterLogin();
  else if (params.get("shared") === "1") $("#loginDlg").showModal();

  sb.auth.onAuthStateChange(async (_ev, session) => {
    const was = state.owner;
    state.owner = OPEN || !!session;
    if (was !== state.owner) { await load(); if (state.owner) afterLogin(); }
  });
}

// ---------------------------------------------------------------------
//  데모용 예시 데이터 (가상의 회사입니다)
// ---------------------------------------------------------------------
function addDays(n) { return new Date(Date.parse(todayKST()) + n * 864e5).toISOString().slice(0, 10); }
function SAMPLE_POSTINGS() {
  const base = { requirements: "", preferred: "", duties: "", process: "", documents: "", apply_via: "" };
  return [
    { ...base, id: "s1", company: "예시소재(주)", title: "소재 분석 연구원", deadline: addDays(2), deadline_time: "18:00", rolling: false, location: "천안", employment_type: "정규직", status: "지원 예정",
      requirements: "- 화학·재료공학 석사 이상\n- 관련 분야 경력 3년 이상", preferred: "- XPS·XRD 분석 경험\n- 파일럿 스케일업 경험", duties: "- 소재 성분·구조 분석\n- 분석법 개발 및 품질 개선", process: "서류 → 1차 면접 → 2차 면접", documents: "이력서, 자기소개서(3문항)", apply_via: "회사 채용 홈페이지" },
    { ...base, id: "s2", company: "샘플케미칼", title: "탄소소재 공정개발", deadline: addDays(6), deadline_time: "", rolling: false, location: "울산", employment_type: "정규직", status: "검토 중" },
    { ...base, id: "s3", company: "데모배터리", title: "음극재 리사이클링 연구", deadline: addDays(13), deadline_time: "23:59", rolling: false, location: "청주", employment_type: "정규직", status: "검토 중" },
    { ...base, id: "s4", company: "가상복합재", title: "열가소성 복합재 컴파운딩", deadline: addDays(21), deadline_time: "", rolling: false, location: "평택", employment_type: "계약직", status: "지원 완료" },
    { ...base, id: "s5", company: "테스트연구소", title: "난연소재 개발 연구원", deadline: null, deadline_time: "", rolling: true, location: "대전", employment_type: "정규직", status: "검토 중" },
    { ...base, id: "s6", company: "예제화학", title: "분석팀 연구원", deadline: addDays(-3), deadline_time: "", rolling: false, location: "화성", employment_type: "정규직", status: "포기" },
  ];
}
const SAMPLE_EXTRACT = {
  company: "예시소재(주)", title: "소재 분석 연구원 (경력)", deadline: addDays(9), deadline_time: "18:00", rolling: false,
  requirements: "- 화학, 재료공학 또는 관련 전공 석사 이상\n- 소재 분석 관련 경력 3년 이상\n- 해외여행에 결격사유가 없는 자",
  preferred: "- XPS, XRD, SEM/EDS 분석 경험자\n- 파일럿 스케일업 경험자\n- SCI 논문 실적 보유자",
  duties: "- 신소재 성분·구조 분석 및 분석법 개발\n- 양산 공정 품질 이슈 분석",
  location: "충남 천안", employment_type: "정규직 (수습 3개월)", process: "서류 → 1차 실무면접 → 2차 임원면접 → 처우협의",
  documents: "이력서, 자기소개서(3문항), 경력기술서", apply_via: "회사 채용 홈페이지",
};

start();
