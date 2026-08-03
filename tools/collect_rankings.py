import json
import os
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone, timedelta
from pathlib import Path

from playwright.sync_api import sync_playwright

API = "https://wp-api.nexon.com/v1/GameData/gcranking"
OUT = Path("site/snapshots")
OUT.mkdir(parents=True, exist_ok=True)
KST = timezone(timedelta(hours=9))

WORLD_NAMES = {
    1:"아우리엘",2:"론도",3:"라인소프",4:"시길",5:"아민타",6:"로메네스",
    7:"이오스",8:"가리안",9:"벨세이즈",10:"사도바",11:"제롬",12:"아티산",
    13:"엘렌",14:"나세르",15:"필레츠",16:"타리아",17:"카렐",18:"나스카",
    19:"벤아트",20:"페넬로페",21:"마커스",22:"르비안트",23:"카시미르",
    24:"트렌체",25:"바이람",26:"하이퍼부스팅",27:"메르비스",
    28:"레전드부스팅",29:"올인원부스팅",
}
CLASS_NAMES = {
    "WildWarrior":"야만투사","AbyssRevenant":"심연추방자",
    "SolarSentinel":"태양감시자","MirageBlade":"환영검사",
    "IncenseArcher":"향사수","RuneScribe":"주문각인사","Enforcer":"집행관",
}
CLASS_SLUGS = [
    "wildwarrior", "abyssrevenant", "solarsentinel", "mirageblade",
    "incensearcher", "runescribe", "enforcer",
]

def fetch_server(page, auth_headers, world_no, realm_no, class_slug):
    group = f"LIVE_W{world_no:02d}"
    world = f"{group}_R{realm_no}"
    result = page.evaluate(
        """async ({api, payload, authHeaders}) => {
          const response = await fetch(api, {
            method: "POST",
            headers: {"Content-Type": "application/json", ...authHeaders},
            body: JSON.stringify(payload)
          });
          return {status: response.status, text: await response.text()};
        }""",
        {"api": API, "payload": {"world_id": world, "world_group_id": group, "class": class_slug}, "authHeaders": auth_headers},
    )
    if result["status"] != 200:
        raise RuntimeError(f"HTTP {result['status']}")
    payload = json.loads(result["text"])
    if payload.get("code") != "0000":
        raise RuntimeError(f"API {payload.get('code')}: {payload.get('message', 'UNKNOWN')}")
    return payload.get("result", {}).get("gc", []) or []

def validate_ranking_rows(rows):
    if len(rows) > 100:
        raise RuntimeError(f"100위를 초과한 응답: {len(rows)}명")
    names = [str(row.get("gc_name") or "").strip() for row in rows]
    if any(not name for name in names):
        raise RuntimeError("닉네임이 비어 있는 랭킹 데이터")
    if len(names) != len(set(names)):
        raise RuntimeError("동일 응답 내 닉네임 중복")
    ranks = [row.get("ranking") for row in rows if row.get("ranking") is not None]
    if len(ranks) != len(set(ranks)):
        raise RuntimeError("동일 응답 내 순위 중복")

def fetch_server_complete(page, auth_headers, world_no, realm_no, class_slug):
    last_error = None
    for attempt in range(1, 4):
        try:
            rows = fetch_server(page, auth_headers, world_no, realm_no, class_slug)
            validate_ranking_rows(rows)
            if rows or attempt == 3:
                return rows, attempt
        except Exception as exc:
            last_error = exc
        page.wait_for_timeout(700 * attempt)
    raise RuntimeError(f"3회 재시도 실패: {last_error or '빈 응답 반복'}")

def discover_worlds(page):
    try:
        options = page.locator("select").nth(0).evaluate(
            """el => [...el.options].map(o => ({value:o.value, text:o.textContent.trim()}))"""
        )
        discovered = {}
        for item in options:
            value = str(item.get("value") or "")
            if value.startswith("W") and value[1:].isdigit():
                discovered[int(value[1:])] = str(item.get("text") or "").strip()
        if discovered:
            return discovered
    except Exception:
        pass
    return dict(WORLD_NAMES)

def member_row(raw, server):
    grade_raw = (raw.get("string_map") or {}).get("grade", 0)
    try:
        grade = int(grade_raw or 0)
    except (TypeError, ValueError):
        grade = 0
    return {
        "nickname": str(raw.get("gc_name") or "").strip(),
        "guild": str(raw.get("guild_name") or "").strip(),
        "class": CLASS_NAMES.get(raw.get("class"), raw.get("class") or "기타"),
        "grade": grade,
        "level": int(raw.get("gc_level") or 0),
        "server": server,
    }

def exponential_score(value, baseline):
    return 0 if value < baseline else 2 ** (value - baseline)

def sorted_members(rows):
    return sorted(rows, key=lambda x: (-x["grade"], -x["level"], x["nickname"]))

def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(path)

def build():
    today = datetime.now(KST)
    label = today.strftime("%Y-%m-%d")
    date_key = today.strftime("%Y_%m_%d")
    stem = f"ranking_{date_key}"

    all_members = []
    playwright = sync_playwright().start()
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(locale="ko-KR")
    auth_headers = {}

    def capture_auth(request):
        if "/GameData/gcranking" not in request.url:
            return
        headers = request.headers
        for name in ("authorization", "x-wp-api-key"):
            if headers.get(name):
                auth_headers[name] = headers[name]

    page.on("request", capture_auth)
    page.goto("https://wp.nexon.com/records/ranking?world=2-1", wait_until="networkidle", timeout=120000)
    page.wait_for_timeout(1000)
    if not auth_headers.get("authorization") or not auth_headers.get("x-wp-api-key"):
        raise RuntimeError("넥슨 임시 인증 헤더를 가져오지 못했습니다")


    worlds = discover_worlds(page)
    failures = []
    active_servers = 0
    request_total = 0
    request_success = 0
    empty_responses = 0
    retry_count = 0

    for world_no, world_name in worlds.items():
        for realm_no in range(1, 6):
            server_rows = []
            for class_slug in CLASS_SLUGS:
                request_total += 1
                try:
                    rows, attempts = fetch_server_complete(
                        page, auth_headers, world_no, realm_no, class_slug
                    )
                    request_success += 1
                    retry_count += attempts - 1
                    if not rows:
                        empty_responses += 1
                    server_rows.extend(rows)
                except Exception as exc:
                    failures.append(
                        f"W{world_no:02d}_R{realm_no}_{class_slug}: {exc}"
                    )
                time.sleep(0.05)
            if not server_rows:
                continue
            active_servers += 1
            server = f"{world_name} {realm_no:02d}"
            all_members.extend(member_row(row, server) for row in server_rows)

    browser.close()
    playwright.stop()

    unique = {}
    for row in all_members:
        unique[(row["server"], row["nickname"])] = row
    all_members = list(unique.values())

    if failures:
        raise RuntimeError(
            f"완전 수집 조건 미달로 기존 스냅샷을 보존합니다: "
            f"{len(failures)}개 요청 실패 / {request_total}개 요청; {failures[:5]}"
        )

    if request_success != request_total:
        raise RuntimeError(
            f"요청 수 불일치로 기존 스냅샷을 보존합니다: "
            f"{request_success}/{request_total}"
        )

    if active_servers < 1 or len(all_members) < 100:
        raise RuntimeError(
            f"수집 데이터가 비정상적으로 적어 기존 스냅샷을 보존합니다: "
            f"{active_servers}개 서버, {len(all_members)}명; 오류: {failures[:5]}"
        )

    guild_members = defaultdict(list)
    for row in all_members:
        guild = row["guild"]
        if guild and guild != "-":
            guild_members[(guild, row["server"])].append(row)

    ranking = []
    for (guild, server), members in guild_members.items():
        level_score = sum(exponential_score(x["level"], 80) for x in members)
        hunt_score = sum(exponential_score(x["grade"], 15) for x in members)
        ranking.append({
            "rank": 0,
            "guild": guild,
            "server": server,
            "members": len(members),
            "hunt_score": hunt_score,
            "level_score": level_score,
            "total_score": level_score + hunt_score,
        })
    ranking.sort(key=lambda x: (-x["total_score"], -x["members"], x["guild"], x["server"]))
    for index, row in enumerate(ranking, 1):
        row["rank"] = index

    level_groups = defaultdict(list)
    grade_groups = defaultdict(list)
    for row in all_members:
        level_groups[str(row["level"])].append(row)
        grade_groups[str(row["grade"])].append(row)

    total = len(all_members)
    level_stats = [
        {"level": key, "count": len(rows), "ratio": len(rows) / total}
        for key, rows in sorted(level_groups.items(), key=lambda x: -int(x[0]))
    ]
    grade_stats = [
        {"grade": key, "count": len(rows), "ratio": len(rows) / total}
        for key, rows in sorted(grade_groups.items(), key=lambda x: -int(x[0]))
    ]

    ranking_file = f"{stem}.json"
    stats_file = f"stats_{stem}.json"
    members_file = f"stats_members_{stem}.json"
    detail_dir = OUT / f"detail_{date_key}"

    write_json(OUT / ranking_file, ranking)
    write_json(OUT / stats_file, {
        "label": label, "file": ranking_file,
        "levelStats": level_stats, "huntGradeStats": grade_stats,
    })
    write_json(OUT / members_file, {
        "label": label, "file": ranking_file,
        "levelMembers": {k: sorted_members(v) for k, v in level_groups.items()},
        "huntGradeMembers": {k: sorted_members(v) for k, v in grade_groups.items()},
    })

    by_server = defaultdict(dict)
    for (guild, server), members in guild_members.items():
        by_class = Counter(x["class"] for x in members)
        by_grade = Counter(str(x["grade"]) for x in members)
        by_server[server][guild] = {
            "members": len(members),
            "byClass": dict(by_class.most_common()),
            "byGrade": dict(sorted(by_grade.items(), key=lambda x: -int(x[0]))),
            "membersList": sorted_members(members),
            "byClassMembers": {
                cls: sorted_members([x for x in members if x["class"] == cls])
                for cls in by_class
            },
            "byGradeMembers": {
                grade: sorted_members([x for x in members if str(x["grade"]) == grade])
                for grade in by_grade
            },
        }
    for server, guilds in by_server.items():
        write_json(detail_dir / f"{server}.json", {"server": server, "guilds": guilds})
        write_json(detail_dir / f"{server.replace(' ', '')}.json", {"server": server, "guilds": guilds})

    index_path = OUT / "index.json"
    try:
        index = json.loads(index_path.read_text(encoding="utf-8"))
    except Exception:
        index = []
    item = {
        "label": label, "file": ranking_file, "statsFile": stats_file,
        "statsMembersFile": members_file, "rows": len(ranking),
        "sheet": "Nexon API",
        "collectedAt": today.isoformat(timespec="seconds"),
        "characters": len(all_members), "servers": active_servers,
        "complete": True, "requests": request_total,
    }
    index = [x for x in index if x.get("label") != label]
    index.insert(0, item)
    write_json(index_path, index[:60])

    write_json(OUT / "collection_status.json", {
        "ok": True, "collectedAt": today.isoformat(timespec="seconds"),
        "servers": active_servers, "characters": len(all_members),
        "guilds": len(ranking), "failures": failures,
        "complete": True,
        "worlds": len(worlds),
        "requests": {
            "total": request_total,
            "success": request_success,
            "empty": empty_responses,
            "retried": retry_count,
        },
    })
    print(json.dumps(item, ensure_ascii=False))

if __name__ == "__main__":
    build()
