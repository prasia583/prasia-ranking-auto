import json
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

TARGET = "https://wp.nexon.com/records/ranking?world=2-1"
OUT = Path("diagnostics")
OUT.mkdir(parents=True, exist_ok=True)

captured = []

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(locale="ko-KR")

        def on_response(response):
            content_type = response.headers.get("content-type", "")
            url = response.url
            if "json" not in content_type.lower() and "rank" not in url.lower():
                return
            item = {
                "url": url,
                "status": response.status,
                "content_type": content_type,
            }
            if "/GameData/gcranking" in url:
                item["method"] = response.request.method
                item["post_data"] = response.request.post_data
                item["request_header_names"] = sorted(response.request.headers.keys())
            try:
                body = response.text()
                if len(body) <= 500000:
                    item["body"] = body
            except Exception as exc:
                item["error"] = str(exc)
            captured.append(item)

        page.on("response", on_response)
        page.goto(TARGET, wait_until="networkidle", timeout=120000)
        page.wait_for_timeout(5000)

        links = page.locator("a").evaluate_all(
            """els => els.map(a => ({text:(a.innerText||'').trim(), href:a.href}))
                       .filter(x => x.text || x.href.includes('ranking'))"""
        )
        selects = page.locator("select").evaluate_all(
            """els => els.map(s => ({name:s.name, id:s.id, value:s.value,
              options:[...s.options].map(o=>({text:o.textContent.trim(), value:o.value}))}))"""
        )
        buttons = page.locator("button").evaluate_all(
            """els => els.map(b => ({text:(b.innerText||'').trim(), disabled:b.disabled}))"""
        )
        tables = page.locator("table").evaluate_all(
            """els => els.map(t => ({text:(t.innerText||'').trim(), html:t.outerHTML.slice(0,200000)}))"""
        )

        result = {
            "target": TARGET,
            "final_url": page.url,
            "title": page.title(),
            "links": links,
            "selects": selects,
            "buttons": buttons,
            "tables": tables,
            "responses": captured,
        }
        (OUT / "discovery.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        browser.close()

if __name__ == "__main__":
    main()
