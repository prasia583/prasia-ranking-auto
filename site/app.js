let SNAP_LIST = [];
let CURRENT_VIEW_ROWS = [];
let FILTERED_ROWS = [];
let CURRENT_GUILD_MEMBER_ROWS = [];

let PAGE_SIZE = 100;
let CURRENT_PAGE = 1;

let CURRENT_OVERALL_STATS = {
  label: "",
  levelStats: [],
  huntGradeStats: []
};

let CURRENT_STAT_MEMBERS = {
  label: "",
  levelMembers: {},
  huntGradeMembers: {}
};

let MEMBER_LIST_STATE = {
  type: "",
  key: "",
  rows: [],
  page: 1,
  pageSize: 100,
  sort: "grade"
};

function getDateKeyFromFile(fileName){
  const m = String(fileName || "").match(/(\d{4}_\d{2}_\d{2})/);
  return m ? m[1] : null;
}

function toNum(v) {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function fmtNum(v){
  const n = toNum(v);
  return n.toLocaleString("ko-KR");
}

function normalizeText(v){
  return String(v ?? "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function keyOfGuildServer(guild, server) {
  return `${normalizeText(guild)}@@${normalizeText(server)}`;
}

function keyOfGuild(guild) {
  return normalizeText(guild);
}

function escapeHtml(s){
  return String(s ?? "")
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;")
    .replace(/'/g,"&#39;");
}
function buildLevelCountMap(rows){
  const m = {};

  for (const row of (rows || [])) {
    const level = String(row?.level ?? "").trim();
    if (!level) continue;
    m[level] = (m[level] || 0) + 1;
  }

  return m;
}
function buildMemberUniqueKey(row){
  return [
    normalizeText(row?.nickname || ""),
    normalizeText(row?.guild || ""),
    normalizeText(row?.server || "")
  ].join("@@");
}

function getAllUniqueMembers(){
  const merged = [];
  const seen = new Set();

  const levelGroups = CURRENT_STAT_MEMBERS.levelMembers || {};
  for (const key of Object.keys(levelGroups)) {
    const rows = Array.isArray(levelGroups[key]) ? levelGroups[key] : [];
    for (const row of rows) {
      const uniq = buildMemberUniqueKey(row);
      if (seen.has(uniq)) continue;
      seen.add(uniq);
      merged.push(row);
    }
  }

  return merged;
}
function normalizeRow(r){
  return {
    curRank: toNum(r.rank ?? 0),
    guild: normalizeText(r.guild ?? ""),
    server: normalizeText(r.server ?? ""),
    members: toNum(r.members ?? 0),
    total: toNum(r.total_score ?? r.score_total ?? r.total ?? 0),
  };
}

function buildPrevIndexes(rows){
  const exactMap = new Map();
  const guildMap = new Map();

  for (const raw of rows) {
    const r = normalizeRow(raw);
    const exactKey = keyOfGuildServer(r.guild, r.server);
    exactMap.set(exactKey, r);

    const gKey = keyOfGuild(r.guild);
    if (!guildMap.has(gKey)) guildMap.set(gKey, []);
    guildMap.get(gKey).push(r);
  }

  return { exactMap, guildMap };
}

function buildGuildCountMap(rows){
  const m = new Map();
  for (const raw of rows) {
    const r = normalizeRow(raw);
    const gKey = keyOfGuild(r.guild);
    m.set(gKey, (m.get(gKey) || 0) + 1);
  }
  return m;
}

function findPreviousRow(curRow, prevIndexes, currentGuildCounts){
  const exactKey = keyOfGuildServer(curRow.guild, curRow.server);
  const exact = prevIndexes.exactMap.get(exactKey);
  if (exact) {
    return { prev: exact, matchType: "exact" };
  }

  const guildKey = keyOfGuild(curRow.guild);
  const prevCandidates = prevIndexes.guildMap.get(guildKey) || [];
  const curCount = currentGuildCounts.get(guildKey) || 0;

  if (curCount === 1 && prevCandidates.length === 1) {
    return { prev: prevCandidates[0], matchType: "guildOnly" };
  }

  return { prev: null, matchType: "none" };
}

async function loadSnapshots() {
  const statusEl = document.getElementById("status");
  const select = document.getElementById("date");

  try {
    const res = await fetch("./snapshots/index.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`index.json HTTP ${res.status}`);
    SNAP_LIST = await res.json();

    if (select) select.innerHTML = "";

    if (!Array.isArray(SNAP_LIST) || SNAP_LIST.length === 0) {
      if (statusEl) statusEl.textContent = "status: 스냅샷이 없습니다";
      return;
    }

    if (select) {
      for (const item of SNAP_LIST) {
        const opt = document.createElement("option");
        opt.value = item.file;
        opt.textContent = item.label;
        select.appendChild(opt);
      }
    }

    bindSearchUI();
    bindPagerUI();
    bindGuildDetailUI();
    bindOverallStatsUI();
    bindMemberListModalUI();

    if (select) {
      await loadRanking(select.value);

      select.addEventListener("change", async (e) => {
        await loadRanking(e.target.value);
        CURRENT_PAGE = 1;
        applySearch();
      });
    }

    if (statusEl) statusEl.textContent = `status: OK (${SNAP_LIST.length} files)`;
  } catch (err) {
    if (statusEl) statusEl.textContent = `status: ERROR: ./snapshots/index.json -> ${err.message}`;
    console.error(err);
  }
}

function bindSearchUI(){
  const input = document.getElementById("search");
  const btnSearch = document.getElementById("btnSearch");
  const btnClear  = document.getElementById("btnClear");
  const form = document.getElementById("searchForm");

  if (btnSearch) {
    btnSearch.addEventListener("click", () => {
      CURRENT_PAGE = 1;
      applySearch();
    });
  }

  if (btnClear) {
    btnClear.addEventListener("click", () => {
      if (input) input.value = "";
      CURRENT_PAGE = 1;
      applySearch();
    });
  }

  if (form) {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      CURRENT_PAGE = 1;
      applySearch();
    });
  } else if (input) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        CURRENT_PAGE = 1;
        applySearch();
      }
    });
  }
}

function bindPagerUI(){
  const pageSize = document.getElementById("pageSize");
  const btnFirst = document.getElementById("btnFirst");
  const btnPrev  = document.getElementById("btnPrev");
  const btnNext  = document.getElementById("btnNext");
  const btnLast  = document.getElementById("btnLast");
  const pagerNums = document.getElementById("pagerNums");

  if (pageSize) {
    PAGE_SIZE = toNum(pageSize.value) || 100;
    pageSize.addEventListener("change", () => {
      PAGE_SIZE = toNum(pageSize.value) || 100;
      CURRENT_PAGE = 1;
      renderCurrentPage();
    });
  }

  if (btnFirst) {
    btnFirst.addEventListener("click", () => {
      CURRENT_PAGE = 1;
      renderCurrentPage();
    });
  }

  if (btnPrev) {
    btnPrev.addEventListener("click", () => {
      if (CURRENT_PAGE > 1) CURRENT_PAGE--;
      renderCurrentPage();
    });
  }

  if (btnNext) {
    btnNext.addEventListener("click", () => {
      const totalPages = Math.max(1, Math.ceil(FILTERED_ROWS.length / PAGE_SIZE));
      if (CURRENT_PAGE < totalPages) CURRENT_PAGE++;
      renderCurrentPage();
    });
  }

  if (btnLast) {
    btnLast.addEventListener("click", () => {
      const totalPages = Math.max(1, Math.ceil(FILTERED_ROWS.length / PAGE_SIZE));
      CURRENT_PAGE = totalPages;
      renderCurrentPage();
    });
  }

  if (pagerNums) {
    pagerNums.addEventListener("click", (e) => {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      const p = t.getAttribute("data-page");
      if (!p) return;

      const page = toNum(p);
      if (!page) return;

      CURRENT_PAGE = page;
      renderCurrentPage();
    });
  }
}

async function fetchRows(fileName) {
  const res = await fetch(`./snapshots/${fileName}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`${fileName} HTTP ${res.status}`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

async function loadOverallStats(fileName){
  try {
    const meta = SNAP_LIST.find(x => x.file === fileName);
    const statsFile = meta?.statsFile || (`stats_${String(fileName)}`);

    const res = await fetch(`./snapshots/${statsFile}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`${statsFile} HTTP ${res.status}`);

    const data = await res.json();

    CURRENT_OVERALL_STATS = {
      label: data?.label || "",
      levelStats: Array.isArray(data?.levelStats) ? data.levelStats : [],
      huntGradeStats: Array.isArray(data?.huntGradeStats) ? data.huntGradeStats : [],
    };
  } catch (err) {
    console.error("전체 통계 로드 실패:", err);
    CURRENT_OVERALL_STATS = {
      label: "",
      levelStats: [],
      huntGradeStats: [],
    };
  }
}

async function loadOverallStatMembers(fileName){
  try {
    const meta = SNAP_LIST.find(x => x.file === fileName);
    const statsMembersFile = meta?.statsMembersFile || (`stats_members_${String(fileName)}`);

    const res = await fetch(`./snapshots/${statsMembersFile}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`${statsMembersFile} HTTP ${res.status}`);

    const data = await res.json();

    CURRENT_STAT_MEMBERS = {
      label: data?.label || "",
      levelMembers: data?.levelMembers || {},
      huntGradeMembers: data?.huntGradeMembers || {},
    };
  } catch (err) {
    console.error("레벨/등급별 캐릭터 목록 로드 실패:", err);
    CURRENT_STAT_MEMBERS = {
      label: "",
      levelMembers: {},
      huntGradeMembers: {},
    };
  }
}

async function loadRanking(fileName) {
  const statusEl = document.getElementById("status");

  try {
    await loadOverallStats(fileName);
    await loadOverallStatMembers(fileName);

    const curRowsRaw = await fetchRows(fileName);
    const curRows = curRowsRaw.map(normalizeRow);

    const idx = SNAP_LIST.findIndex((x) => x.file === fileName);
    const prevFile = (idx >= 0 && idx + 1 < SNAP_LIST.length) ? SNAP_LIST[idx + 1].file : null;

    let prevIndexes = { exactMap: new Map(), guildMap: new Map() };
    if (prevFile) {
      const prevRowsRaw = await fetchRows(prevFile);
      prevIndexes = buildPrevIndexes(prevRowsRaw);
    }

    const currentGuildCounts = buildGuildCountMap(curRows);

    CURRENT_VIEW_ROWS = curRows.map((r) => {
      const found = prevFile
        ? findPreviousRow(r, prevIndexes, currentGuildCounts)
        : { prev: null, matchType: "none" };

      const prev = found.prev;

      let moveText = "-";
      let moveClass = "delta-flat";

      let scoreText = prevFile ? "NEW" : "";
      let scoreClass = "delta-flat";

      if (prev) {
        const rankDelta = (prev.curRank && r.curRank) ? (prev.curRank - r.curRank) : 0;
        const scoreDelta = r.total - prev.total;

        if (rankDelta > 0) {
          moveText = `▲ ${rankDelta}`;
          moveClass = "delta-up";
        } else if (rankDelta < 0) {
          moveText = `▼ ${Math.abs(rankDelta)}`;
          moveClass = "delta-down";
        } else {
          moveText = "-";
          moveClass = "delta-flat";
        }

        if (scoreDelta > 0) {
          scoreText = `▲ ${Math.abs(scoreDelta).toLocaleString("ko-KR")}`;
          scoreClass = "delta-up";
        } else if (scoreDelta < 0) {
          scoreText = `▼ ${Math.abs(scoreDelta).toLocaleString("ko-KR")}`;
          scoreClass = "delta-down";
        } else {
          scoreText = "-";
          scoreClass = "delta-flat";
        }
      }

      return {
        curRank: r.curRank,
        guild: r.guild,
        server: r.server,
        members: r.members,
        total: r.total,
        moveText,
        moveClass,
        scoreText,
        scoreClass,
        matchType: found.matchType
      };
    });

    CURRENT_PAGE = 1;
    applySearch();

    if (statusEl) {
      statusEl.textContent = prevFile
        ? `status: OK (${fileName}) - ${curRows.length} rows / compare: ${prevFile}`
        : `status: OK (${fileName}) - ${curRows.length} rows / compare: (없음)`;
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = `status: ERROR: ${fileName} -> ${err.message}`;
    console.error(err);
  }
}

function applySearch(){
  const input = document.getElementById("search");
  const q = normalizeText(input?.value ?? "").toLowerCase();

  FILTERED_ROWS = !q ? CURRENT_VIEW_ROWS : CURRENT_VIEW_ROWS.filter((x) => {
    const guild = normalizeText(x.guild).toLowerCase();
    const server = normalizeText(x.server).toLowerCase();
    return guild.includes(q) || server.includes(q);
  });

  renderCurrentPage();
}

function renderCurrentPage(){
  const total = FILTERED_ROWS.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (CURRENT_PAGE > totalPages) CURRENT_PAGE = totalPages;

  const start = (CURRENT_PAGE - 1) * PAGE_SIZE;
  const end = start + PAGE_SIZE;
  const pageRows = FILTERED_ROWS.slice(start, end);

  renderRows(pageRows);
  renderPager(total, totalPages, start, Math.min(end, total));
}

function renderRows(rows){
  const tbody = document.getElementById("rank");
  if (!tbody) return;

  let html = "";
  for (const x of rows) {
    html += `
      <tr data-guild="${escapeHtml(x.guild)}" data-server="${escapeHtml(x.server)}" style="cursor:pointer;">
        <td class="delta-cell ${x.moveClass}">${escapeHtml(x.moveText)}</td>
        <td>${x.curRank || ""}</td>
        <td>${escapeHtml(x.guild)}</td>
        <td>${fmtNum(x.members)}</td>
        <td>${escapeHtml(x.server)}</td>
        <td>${fmtNum(x.total)}</td>
        <td class="delta-cell ${x.scoreClass}">${escapeHtml(x.scoreText)}</td>
      </tr>
    `;
  }
  tbody.innerHTML = html;
}

function renderPager(total, totalPages, from, to){
  const infoEl = document.getElementById("pagerInfo");
  const pageEl = document.getElementById("pagerPage");
  const numsEl = document.getElementById("pagerNums");

  const btnFirst = document.getElementById("btnFirst");
  const btnPrev  = document.getElementById("btnPrev");
  const btnNext  = document.getElementById("btnNext");
  const btnLast  = document.getElementById("btnLast");

  if (infoEl) infoEl.innerHTML = `표시: <b>${total ? (from + 1) : 0}</b>~<b>${to}</b> / 전체 <b>${total}</b>`;
  if (pageEl) pageEl.innerHTML = `<b>${CURRENT_PAGE}</b> / ${totalPages}`;

  const prevDisabled = CURRENT_PAGE <= 1 || totalPages <= 1;
  const nextDisabled = CURRENT_PAGE >= totalPages || totalPages <= 1;

  if (btnFirst) btnFirst.disabled = prevDisabled;
  if (btnPrev)  btnPrev.disabled  = prevDisabled;
  if (btnNext)  btnNext.disabled  = nextDisabled;
  if (btnLast)  btnLast.disabled  = nextDisabled;

  if (numsEl) {
    const MAX_BTNS = 10;
    let startPage = Math.max(1, CURRENT_PAGE - Math.floor(MAX_BTNS / 2));
    let endPage = startPage + MAX_BTNS - 1;

    if (endPage > totalPages) {
      endPage = totalPages;
      startPage = Math.max(1, endPage - MAX_BTNS + 1);
    }

    let html = "";
    for (let p = startPage; p <= endPage; p++) {
      const active = (p === CURRENT_PAGE) ? "active" : "";
      html += `<button type="button" class="${active}" data-page="${p}">${p}</button>`;
    }
    numsEl.innerHTML = html;
  }
}

function bindGuildDetailUI(){
  const tbody = document.getElementById("rank");
  const modal = document.getElementById("guildModal");
  const closeBtn = document.getElementById("gmClose");

  if (closeBtn) closeBtn.addEventListener("click", hideModal);
  if (modal) {
  modal.addEventListener("click", (e) => {
    if (e.target === modal) {
      hideModal();
      return;
    }

    const btn = e.target.closest(".guild-member-open");
if (!btn) return;

e.preventDefault();
e.stopPropagation();

const type = btn.getAttribute("data-type");
const key = btn.getAttribute("data-key");
openGuildFilteredMemberList(type, key);
  });
}

  if (!tbody) return;

  tbody.addEventListener("click", async (e) => {
    const tr = e.target.closest("tr");
    if (!tr) return;

    const guild = tr.getAttribute("data-guild") || "";
    const server = tr.getAttribute("data-server") || "";
    if (!guild || !server) return;

    const fileName = document.getElementById("date")?.value;
    const dateKey = getDateKeyFromFile(fileName);
    if (!dateKey) {
      alert("날짜키를 못 찾았어요. 파일명에 2026_03_05 형태가 있어야 합니다.");
      return;
    }

    try {
           const serverNorm = normalizeText(server);
      const m = serverNorm.match(/^(.*?)(\d+)$/) || serverNorm.match(/^(.*?)\s+(\d+)$/);

let candidates = [];

if (m) {
  const namePart = normalizeText(m[1] || "");
  const numRaw = String(m[2] || "");
  const numNoZero = String(Number(numRaw));
  const num2 = numNoZero.padStart(2, "0");

  candidates = [
    `${namePart}${num2}`,
    `${namePart} ${num2}`,
    `${namePart}_${num2}`,
    `${namePart}-${num2}`,

    `${namePart}${numNoZero}`,
    `${namePart} ${numNoZero}`,
    `${namePart}_${numNoZero}`,
    `${namePart}-${numNoZero}`,

    serverNorm,
    serverNorm.replace(/\s+/g, ""),
    serverNorm.replace(/\s+/g, "_"),
    serverNorm.replace(/\s+/g, "-"),
    serverNorm.replace(/[^\w가-힣]+/g, "")
  ];
} else {
  candidates = [
    serverNorm.replace(/\s+/g, ""),
    serverNorm,
    serverNorm.replace(/\s+/g, "_"),
    serverNorm.replace(/\s+/g, "-"),
    serverNorm.replace(/[^\w가-힣]+/g, "")
  ];
}

candidates = Array.from(new Set(candidates.filter(Boolean)));

      let data = null;
      let lastErr = null;

     for (const s of candidates) {
  const serverFile = `${s}.json`;
  const url = `./snapshots/detail_${dateKey}/${serverFile}`;

  console.log("상세 시도 서버명:", server);
  console.log("정규화 서버명:", serverNorm);
  console.log("상세 시도 후보:", s);
  console.log("상세 요청 URL:", url);

  const res = await fetch(url, { cache: "no-store" });
  if (res.ok) {
    data = await res.json();
    console.log("상세 로드 성공:", url);
    break;
  } else {
    lastErr = `HTTP ${res.status} / ${url}`;
  }
}

      if (!data) throw new Error(`detail fetch 실패: ${lastErr}`);

      const guildKey = normalizeText(guild);
      const g = data?.guilds?.[guildKey];

      if (!g) {
        showModal(
          guildKey,
          `${serverNorm} / ${dateKey}`,
          `<div style="opacity:.85;">집계 데이터 없음</div>`,
          ""
        );
        return;
      }

      CURRENT_GUILD_MEMBER_ROWS = Array.isArray(g.membersList) ? g.membersList : [];

const clsHtml = renderKeyValueTable(g.byClass, "직업", "인원", "guild-class");
const grdHtml = renderKeyValueTable(g.byGrade, "등급", "인원", "guild-grade");

const levelMap = buildLevelCountMap(g.membersList || []);
const lvlHtml = renderKeyValueTable(levelMap, "레벨", "인원", "guild-level");

showModal(
  guildKey,
  `${serverNorm} / ${dateKey} / 총원 ${Number(g.members || 0).toLocaleString("ko-KR")}명`,
  clsHtml,
  grdHtml,
  lvlHtml
);
    } catch (err) {
      alert("상세 불러오기 실패: " + err.message);
      console.error(err);
    }
  });
}

function renderKeyValueTable(obj, col1, col2, clickType = ""){
  const entries = Object.entries(obj || {});
  if (entries.length === 0) return `<div style="opacity:.85;">데이터 없음</div>`;

  if (clickType === "guild-grade" || clickType === "guild-level") {
    entries.sort((a, b) => {
      const ak = Number(a[0]);
      const bk = Number(b[0]);

      if (Number.isFinite(ak) && Number.isFinite(bk)) {
        return bk - ak; // 등급 높은 순
      }
      return String(b[0]).localeCompare(String(a[0]), "ko");
    });
  } else {
    entries.sort((a, b) => (b[1] || 0) - (a[1] || 0)); // 인원수 많은 순
  }

  let html = `
    <table style="width:100%; border-collapse:collapse; font-size:16px; table-layout:fixed;">
      <thead>
        <tr>
          <th style="text-align:center !important; border-bottom:1px solid #23324a; padding:10px;">${escapeHtml(col1)}</th>
          <th style="text-align:center !important; border-bottom:1px solid #23324a; padding:10px;">${escapeHtml(col2)}</th>
        </tr>
      </thead>
      <tbody>
  `;

  for (const [k, v] of entries){
    html += `
      <tr>
        <td style="padding:10px; border-bottom:1px solid rgba(35,50,74,.6); text-align:center !important;">${escapeHtml(k)}</td>
        <td style="padding:10px; border-bottom:1px solid rgba(35,50,74,.6); text-align:center !important;">
          ${
            clickType
              ? `<button
                  type="button"
                  class="guild-member-open"
                  data-type="${escapeHtml(clickType)}"
                  data-key="${escapeHtml(String(k))}"
                  style="background:none; border:none; color:#7fb0ff; font-weight:800; cursor:pointer;"
                >${Number(v || 0).toLocaleString("ko-KR")}</button>`
              : Number(v || 0).toLocaleString("ko-KR")
          }
        </td>
      </tr>
    `;
  }

  html += `</tbody></table>`;
  return html;
}

function showModal(title, sub, clsHtml, grdHtml, lvlHtml = ""){
  const modal = document.getElementById("guildModal");
  const t = document.getElementById("gmTitle");
  const s = document.getElementById("gmSub");
  const c = document.getElementById("gmClass");
  const g = document.getElementById("gmGrade");
  const l = document.getElementById("gmLevel");

  if (t) t.textContent = title;
  if (s) s.textContent = sub;
  if (c) c.innerHTML = clsHtml;
  if (g) g.innerHTML = grdHtml;
  if (l) l.innerHTML = lvlHtml;

  if (modal) modal.style.display = "block";
}

function hideModal(){
  const modal = document.getElementById("guildModal");
  if (modal) modal.style.display = "none";
}

function bindOverallStatsUI(){
  const btn = document.getElementById("btnOverallStats");
  const modal = document.getElementById("overallModal");
  const closeBtn = document.getElementById("omClose");

  const searchInput = document.getElementById("omSearch");
  const searchBtn = document.getElementById("omSearchBtn");
  const clearBtn = document.getElementById("omSearchClear");

  if (btn) {
    btn.addEventListener("click", () => {
      const levelHtml = renderOverallStatTable(
        CURRENT_OVERALL_STATS.levelStats,
        "level",
        "레벨",
        "level"
      );

      const gradeHtml = renderOverallStatTable(
        CURRENT_OVERALL_STATS.huntGradeStats,
        "grade",
        "토벌등급",
        "grade"
      );

      showOverallModal(
        "전체 통계",
        CURRENT_OVERALL_STATS.label ? `${CURRENT_OVERALL_STATS.label} 기준` : "",
        levelHtml,
        gradeHtml
      );
    });
  }

  if (closeBtn) closeBtn.addEventListener("click", hideOverallModal);

  if (searchBtn) {
    searchBtn.addEventListener("click", () => {
      searchOverallMembers();
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      clearOverallMemberSearch();
    });
  }

  if (searchInput) {
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        searchOverallMembers();
      }
    });
  }

  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) hideOverallModal();

      const btnEl = e.target.closest(".stat-open-members");
      if (!btnEl) return;

      const type = btnEl.getAttribute("data-type");
      const key = btnEl.getAttribute("data-key");
      openMemberListModal(type, key);
    });
  }
}


function renderOverallStatTable(rows, keyField, keyLabel, clickType){
  const list = Array.isArray(rows) ? [...rows] : [];
  if (list.length === 0) return `<div style="opacity:.85;">데이터 없음</div>`;

  let html = `
    <table style="width:100%; border-collapse:collapse; font-size:16px; table-layout:fixed;">
      <thead>
        <tr>
          <th style="text-align:center; border-bottom:1px solid #23324a; padding:10px;">${escapeHtml(keyLabel)}</th>
          <th style="text-align:center; border-bottom:1px solid #23324a; padding:10px;">인원수</th>
          <th style="text-align:center; border-bottom:1px solid #23324a; padding:10px;">비율</th>
        </tr>
      </thead>
      <tbody>
  `;

  for (const row of list){
    const key = String(row?.[keyField] ?? "");
    const count = Number(row?.count || 0);
    const ratio = Number(row?.ratio || 0);

    html += `
      <tr>
        <td style="padding:10px; border-bottom:1px solid rgba(35,50,74,.6); text-align:center;">
          <button
            type="button"
            class="stat-open-members"
            data-type="${escapeHtml(clickType)}"
            data-key="${escapeHtml(key)}"
            style="background:none; border:none; color:#7fb0ff; font-weight:800; cursor:pointer;"
          >
            ${escapeHtml(key)}
          </button>
        </td>
        <td style="padding:10px; border-bottom:1px solid rgba(35,50,74,.6); text-align:center;">
          ${count.toLocaleString("ko-KR")}
        </td>
        <td style="padding:10px; border-bottom:1px solid rgba(35,50,74,.6); text-align:center;">
          ${(ratio * 100).toFixed(2)}%
        </td>
      </tr>
    `;
  }

  html += `</tbody></table>`;
  return html;
}

function showOverallModal(title, sub, levelHtml, gradeHtml){
  const modal = document.getElementById("overallModal");
  const t = document.getElementById("omTitle");
  const s = document.getElementById("omSub");
  const l = document.getElementById("omLevel");
  const g = document.getElementById("omGrade");

  if (t) t.textContent = title;
  if (s) s.textContent = sub;
  if (l) l.innerHTML = levelHtml;
  if (g) g.innerHTML = gradeHtml;

  if (modal) modal.style.display = "block";
}

function hideOverallModal(){
  const modal = document.getElementById("overallModal");
  if (modal) modal.style.display = "none";
}
function searchOverallMembers(){
  const input = document.getElementById("omSearch");
  const q = normalizeText(input?.value || "").toLowerCase();

  if (!q) {
    alert("검색할 캐릭터 닉네임을 입력하세요.");
    if (input) input.focus();
    return;
  }

  const allMembers = getAllUniqueMembers();

  const matched = allMembers.filter((row) => {
    const nickname = normalizeText(row?.nickname || "").toLowerCase();
    return nickname.includes(q);
  });

  matched.sort((a, b) => {
    const gradeDiff = toNum(b?.grade || 0) - toNum(a?.grade || 0);
    if (gradeDiff !== 0) return gradeDiff;

    const levelDiff = toNum(b?.level || 0) - toNum(a?.level || 0);
    if (levelDiff !== 0) return levelDiff;

    return normalizeText(a?.nickname || "").localeCompare(normalizeText(b?.nickname || ""), "ko");
  });

    MEMBER_LIST_STATE = {
    type: "search",
    key: q,
    rows: matched,
    page: 1,
    pageSize: 100,
    sort: "grade"
  };

  renderMemberListModal();

  const modal = document.getElementById("memberListModal");
  if (modal) modal.style.display = "block";
}

function clearOverallMemberSearch(){
  const input = document.getElementById("omSearch");
  if (input) input.value = "";
}

function openMemberListModal(type, key){
  let rows = [];

  if (type === "level") {
    rows = CURRENT_STAT_MEMBERS.levelMembers?.[key] || [];
  } else if (type === "grade") {
    rows = CURRENT_STAT_MEMBERS.huntGradeMembers?.[key] || [];
  }

   MEMBER_LIST_STATE = {
    type,
    key,
    rows: Array.isArray(rows) ? rows : [],
    page: 1,
    pageSize: 100,
    sort: "grade"
  };

  renderMemberListModal();

  const modal = document.getElementById("memberListModal");
  if (modal) modal.style.display = "block";
}

function hideMemberListModal(){
  const modal = document.getElementById("memberListModal");
  if (modal) modal.style.display = "none";
}
function buildClassRatioHtml(rows){
  const list = Array.isArray(rows) ? rows : [];
  const total = list.length;

  if (!total) return "";

  const map = {};

  for (const row of list) {
    const cls = normalizeText(row?.class || "기타");
    map[cls] = (map[cls] || 0) + 1;
  }

  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);

  let html = `
    <div style="
      margin: 14px 0 16px;
      padding: 14px;
      border: 1px solid #23324a;
      border-radius: 12px;
      background: rgba(15, 23, 38, .75);
    ">
      <div style="font-weight:900; font-size:17px; margin-bottom:10px;">
        직업 분포
      </div>

      <div style="display:flex; flex-wrap:wrap; gap:8px;">
  `;

  for (const [cls, count] of entries) {
    const ratio = total
      ? ((count / total) * 100).toFixed(1)
      : "0.0";

    html += `
      <span style="
        display:inline-flex;
        align-items:center;
        gap:6px;
        padding:8px 10px;
        border:1px solid #2b3c5c;
        border-radius:999px;
        background:#111a2a;
        color:#fff;
        font-weight:800;
        font-size:14px;
      ">
        <span style="color:#7fb0ff;">
          ${escapeHtml(cls)}
        </span>

        <span>
          ${count.toLocaleString("ko-KR")}명
        </span>

        <span style="opacity:.8;">
          ${ratio}%
        </span>
      </span>
    `;
  }

  html += `
      </div>
    </div>
  `;

  return html;
}
function sortMemberRows(rows, sortType = "grade"){
  const list = Array.isArray(rows) ? [...rows] : [];

  if (sortType === "class") {
    list.sort((a, b) => {
      const classDiff = normalizeText(a?.class || "").localeCompare(
        normalizeText(b?.class || ""),
        "ko"
      );
      if (classDiff !== 0) return classDiff;

      const gradeDiff = toNum(b?.grade || 0) - toNum(a?.grade || 0);
      if (gradeDiff !== 0) return gradeDiff;

      const levelDiff = toNum(b?.level || 0) - toNum(a?.level || 0);
      if (levelDiff !== 0) return levelDiff;

      return normalizeText(a?.nickname || "").localeCompare(
        normalizeText(b?.nickname || ""),
        "ko"
      );
    });
    return list;
  }

  list.sort((a, b) => {
    const gradeDiff = toNum(b?.grade || 0) - toNum(a?.grade || 0);
    if (gradeDiff !== 0) return gradeDiff;

    const levelDiff = toNum(b?.level || 0) - toNum(a?.level || 0);
    if (levelDiff !== 0) return levelDiff;

    return normalizeText(a?.nickname || "").localeCompare(
      normalizeText(b?.nickname || ""),
      "ko"
    );
  });

  return list;
}
function openGuildFilteredMemberList(type, key){
  let rows = [];

  if (type === "guild-class") {
  rows = CURRENT_GUILD_MEMBER_ROWS.filter((row) => {
    return normalizeText(row?.class || "") === normalizeText(key);
  });
} else if (type === "guild-grade") {
  rows = CURRENT_GUILD_MEMBER_ROWS.filter((row) => {
    return String(row?.grade ?? "") === String(key);
  });
} else if (type === "guild-level") {
  rows = CURRENT_GUILD_MEMBER_ROWS.filter((row) => {
    return String(row?.level ?? "") === String(key);
  });
}

  rows.sort((a, b) => {
    const gradeDiff = toNum(b?.grade || 0) - toNum(a?.grade || 0);
    if (gradeDiff !== 0) return gradeDiff;

    const levelDiff = toNum(b?.level || 0) - toNum(a?.level || 0);
    if (levelDiff !== 0) return levelDiff;

    return normalizeText(a?.nickname || "").localeCompare(normalizeText(b?.nickname || ""), "ko");
  });

    MEMBER_LIST_STATE = {
    type,
    key,
    rows,
    page: 1,
    pageSize: 100,
    sort: "grade"
  };

  renderMemberListModal();

  const modal = document.getElementById("memberListModal");
  if (modal) modal.style.display = "block";
}
function renderMemberListModal(){
  const titleEl = document.getElementById("mlTitle");
  const subEl = document.getElementById("mlSub");
  const wrapEl = document.getElementById("mlTableWrap");
  const pageInfoEl = document.getElementById("mlPageInfo");
  const prevBtn = document.getElementById("mlPrev");
  const nextBtn = document.getElementById("mlNext");

  const { type, key, rows, page, pageSize, sort } = MEMBER_LIST_STATE;
  const sortedRows = sortMemberRows(rows, sort);
  const total = sortedRows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, totalPages);

  MEMBER_LIST_STATE.page = currentPage;

  const start = (currentPage - 1) * pageSize;
  const end = start + pageSize;
  const pageRows = sortedRows.slice(start, end);

  if (titleEl) {
    if (type === "level") {
      titleEl.textContent = `레벨 ${key} 캐릭터 목록`;
    } else if (type === "grade") {
      titleEl.textContent = `토벌등급 ${key} 캐릭터 목록`;
    } else if (type === "search") {
      titleEl.textContent = `캐릭터 검색 결과`;
    } else if (type === "guild-class") {
      titleEl.textContent = `직업 ${key} 캐릭터 목록`;
    } else if (type === "guild-grade") {
      titleEl.textContent = `토벌등급 ${key} 캐릭터 목록`;
    } else if (type === "guild-level") {
      titleEl.textContent = `레벨 ${key} 캐릭터 목록`;
    } else {
      titleEl.textContent = `캐릭터 목록`;
    }
  }

  if (subEl) {
    if (type === "search") {
      subEl.textContent = `${CURRENT_STAT_MEMBERS.label || ""} / 검색어: "${key}" / 총 ${total.toLocaleString("ko-KR")}명`;
    } else if (type === "guild-class" || type === "guild-grade" || type === "guild-level") {
      subEl.textContent = `총 ${total.toLocaleString("ko-KR")}명`;
    } else {
      subEl.textContent = `${CURRENT_STAT_MEMBERS.label || ""} / 총 ${total.toLocaleString("ko-KR")}명`;
    }
  }

  if (wrapEl) {
    const classRatioHtml =
  type === "grade" || type === "guild-grade"
    ? buildClassRatioHtml(sortedRows)
    : "";

let html = `
      ${classRatioHtml}

      <div style="display:flex; justify-content:flex-end; margin-bottom:12px;">
        <select id="mlSort" style="padding:8px 10px; background:#0f1726; color:#fff; border:1px solid #23324a; border-radius:8px;">
          <option value="grade" ${sort === "grade" ? "selected" : ""}>기본정렬(등급/레벨)</option>
          <option value="class" ${sort === "class" ? "selected" : ""}>직업순 정렬</option>
        </select>
      </div>

      <table style="width:100%; border-collapse:collapse; font-size:15px; table-layout:fixed;">
        <thead>
          <tr>
            <th style="padding:10px; text-align:center; width:260px;">닉네임</th>
            <th style="padding:10px; text-align:center;">결사</th>
            <th style="padding:10px; text-align:center;">서버</th>
            <th style="padding:10px; text-align:center;">직업</th>
            <th style="padding:10px; text-align:center;">레벨</th>
            <th style="padding:10px; text-align:center;">토벌등급</th>
          </tr>
        </thead>
        <tbody>
    `;

    for (const row of pageRows){
      html += `
        <tr>
          <td
            title="${escapeHtml(row.nickname || "")}"
            style="
              padding:10px;
              border-top:1px solid #23324a;
              text-align:center;
              white-space:nowrap;
              overflow:hidden;
              text-overflow:ellipsis;
              max-width:0;
            "
          >${escapeHtml(row.nickname || "")}</td>
          <td style="padding:10px; border-top:1px solid #23324a; text-align:center;">${escapeHtml(row.guild || "")}</td>
          <td style="padding:10px; border-top:1px solid #23324a; text-align:center;">${escapeHtml(row.server || "")}</td>
          <td style="padding:10px; border-top:1px solid #23324a; text-align:center;">${escapeHtml(row.class || "")}</td>
          <td style="padding:10px; border-top:1px solid #23324a; text-align:center;">${escapeHtml(String(row.level || ""))}</td>
          <td style="padding:10px; border-top:1px solid #23324a; text-align:center;">${escapeHtml(String(row.grade || ""))}</td>
        </tr>
      `;
    }

    if (pageRows.length === 0) {
      html += `
        <tr>
          <td colspan="6" style="padding:16px; border-top:1px solid #23324a; text-align:center; opacity:.85;">
            데이터 없음
          </td>
        </tr>
      `;
    }

    html += `</tbody></table>`;
    wrapEl.innerHTML = html;

    const sortEl = document.getElementById("mlSort");
    if (sortEl) {
      sortEl.addEventListener("change", (e) => {
        MEMBER_LIST_STATE.sort = e.target.value;
        MEMBER_LIST_STATE.page = 1;
        renderMemberListModal();
      });
    }
  }

  if (pageInfoEl) {
    pageInfoEl.textContent = `${currentPage} / ${totalPages}`;
  }

  if (prevBtn) prevBtn.disabled = currentPage <= 1;
  if (nextBtn) nextBtn.disabled = currentPage >= totalPages;
}
function bindMemberListModalUI(){
  const modal = document.getElementById("memberListModal");
  const closeBtn = document.getElementById("mlClose");
  const prevBtn = document.getElementById("mlPrev");
  const nextBtn = document.getElementById("mlNext");

  if (closeBtn) closeBtn.addEventListener("click", hideMemberListModal);

  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) hideMemberListModal();
    });
  }

  if (prevBtn) {
    prevBtn.addEventListener("click", () => {
      if (MEMBER_LIST_STATE.page > 1) {
        MEMBER_LIST_STATE.page--;
        renderMemberListModal();
      }
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener("click", () => {
      const totalPages = Math.max(1, Math.ceil(MEMBER_LIST_STATE.rows.length / MEMBER_LIST_STATE.pageSize));
      if (MEMBER_LIST_STATE.page < totalPages) {
        MEMBER_LIST_STATE.page++;
        renderMemberListModal();
      }
    });
  }
}

loadSnapshots();
