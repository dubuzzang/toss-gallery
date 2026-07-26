"""예약 실행용 스크립트 (화면 없이 조용히 실행됨).
Windows 작업 스케줄러에 이 파일을 등록해두면, 정해진 시간마다 자동으로
새 특가 상품을 뽑아서 엑셀로 저장해줘요.

미리 준비할 것: gui_app.py(또는 exe)로 최소 한 번은 직접 로그인을 해둬야 해요.
(로그인 정보가 저장되어 있어야 예약 실행 때 자동으로 로그인된 상태로 열려요)

설정은 이 파일과 같은 폴더의 '예약설정.json' 파일에서 읽어와요.
"""
import json
import sys
from datetime import datetime
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE_DIR))
import core  # noqa: E402

from playwright.sync_api import sync_playwright

USER_DATA_DIR = str(BASE_DIR / "browser_profile")
SEEN_PATH = str(BASE_DIR / "이미추출한상품.json")
CONFIG_PATH = BASE_DIR / "예약설정.json"
LOG_PATH = BASE_DIR / "예약실행_로그.txt"


def log(msg):
    line = f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    print(line)
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def load_config():
    if not CONFIG_PATH.exists():
        default = {
            "urls": [
                "https://sharelink.toss.im/links/recommended-products?categoryIds=50995"
            ],
            "min_discount": None,
            "dedupe": True,
            "sheet_id": "",
            "site_url": "",
            "admin_user": "",
            "admin_password": ""
        }
        CONFIG_PATH.write_text(json.dumps(default, ensure_ascii=False, indent=2), encoding="utf-8")
        log(f"'예약설정.json' 파일이 없어서 기본값으로 새로 만들었어요. 내용을 확인/수정해주세요: {CONFIG_PATH}")
        return default
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def main():
    cfg = load_config()
    urls = cfg.get("urls", [])
    min_discount = cfg.get("min_discount")
    dedupe = cfg.get("dedupe", True)
    sheet_id = cfg.get("sheet_id", "")
    site_url = cfg.get("site_url", "")
    admin_user = cfg.get("admin_user", "")
    admin_password = cfg.get("admin_password", "")

    if not urls:
        log("설정된 링크가 없어요. 예약설정.json 을 확인해주세요.")
        return

    log("예약 실행 시작")
    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            USER_DATA_DIR, headless=True, permissions=["clipboard-read", "clipboard-write"],
        )
        page = context.pages[0] if context.pages else context.new_page()

        all_products = []
        for i, url in enumerate(urls):
            log(f"[{i + 1}/{len(urls)}번째 페이지] {url}")
            products = core.scrape_one_page(page, url, min_discount, log)
            all_products.extend(products)

        context.close()

    if dedupe:
        seen = core.load_seen_names(SEEN_PATH)
        before = len(all_products)
        all_products = core.remove_already_seen(all_products, seen)
        log(f"중복 제거: {before}개 → {len(all_products)}개")

    if not all_products:
        log("새로 담을 상품이 없어요. 종료합니다.")
        return

    all_products = core.sort_by_discount_desc(all_products)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_path = BASE_DIR / f"결과_{timestamp}.xlsx"
    core.save_excel(all_products, out_path)
    log(f"엑셀 저장 완료: {out_path}")

    if dedupe:
        seen = core.load_seen_names(SEEN_PATH)
        seen.update(p.get("name") for p in all_products if p.get("name"))
        core.save_seen_names(SEEN_PATH, seen)

    if sheet_id:
        cred_path = BASE_DIR / "google_credentials.json"
        core.upload_to_google_sheet(all_products, str(cred_path), sheet_id, log)

    if site_url:
        log("쇼핑 갤러리 사이트로 바로 올리는 중...")
        core.upload_to_gallery(all_products, site_url, admin_user, admin_password, log)

    log("예약 실행 완료")


if __name__ == "__main__":
    main()
