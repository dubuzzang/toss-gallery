import os
import re
import sys
import threading
import subprocess
from pathlib import Path

if getattr(sys, "frozen", False):
    BASE_DIR = Path(sys.executable).resolve().parent
else:
    BASE_DIR = Path(__file__).resolve().parent

sys.path.insert(0, str(BASE_DIR))
import core  # noqa: E402  (core.py 가 PLAYWRIGHT_BROWSERS_PATH 환경변수를 먼저 설정함)

import tkinter as tk
from tkinter import ttk, messagebox

from playwright.sync_api import sync_playwright

USER_DATA_DIR = str(BASE_DIR / "browser_profile")
SEEN_PATH = str(BASE_DIR / "이미추출한상품.json")
SITE_CONFIG_PATH = str(BASE_DIR / "사이트설정.json")

TOSS_BLUE = "#3182f6"
TOSS_BLUE_DARK = "#2272eb"
BG = "#f5f6f8"
CARD_BG = "#ffffff"
TEXT_DARK = "#191f28"
TEXT_GREY = "#6b7684"
BORDER = "#e5e8eb"
DISABLED_BG = "#d1d6db"


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("토스 쉐어링크 → 엑셀 추출기")
        self.geometry("700x820")
        self.minsize(700, 760)
        self.configure(bg=BG)

        self.context = None
        self.page = None
        self.playwright = None
        self.result_path = None

        self.dedupe_var = tk.BooleanVar(value=True)

        self._build_ui()

    # ── 화면 구성 ──────────────────────────────────────────────
    def _build_ui(self):
        style = ttk.Style(self)
        try:
            style.theme_use("clam")
        except Exception:
            pass
        style.configure("TFrame", background=BG)
        style.configure("Sub.TLabel", background=BG, foreground=TEXT_GREY, font=("Malgun Gothic", 10))
        style.configure("Field.TLabel", background=BG, foreground=TEXT_DARK, font=("Malgun Gothic", 10, "bold"))
        style.configure("Step.TLabel", background=BG, foreground=TOSS_BLUE, font=("Malgun Gothic", 10, "bold"))
        style.configure("Check.TCheckbutton", background=BG, foreground=TEXT_DARK, font=("Malgun Gothic", 10))

        style.configure("Blue.TButton", font=("Malgun Gothic", 11, "bold"), padding=12,
                         background=TOSS_BLUE, foreground="white", borderwidth=0)
        style.map("Blue.TButton",
                  background=[("disabled", DISABLED_BG), ("active", TOSS_BLUE_DARK)],
                  foreground=[("disabled", "#8b95a1")])

        style.configure("Grey.TButton", font=("Malgun Gothic", 10), padding=9,
                         background="#e5e8eb", foreground=TEXT_DARK, borderwidth=0)
        style.map("Grey.TButton", background=[("disabled", "#f0f1f3"), ("active", "#d8dbe0")])

        header = tk.Frame(self, bg=TOSS_BLUE, height=86)
        header.pack(fill="x")
        header.pack_propagate(False)
        tk.Label(header, text="토스 쉐어링크 → 엑셀 추출기", bg=TOSS_BLUE, fg="white",
                 font=("Malgun Gothic", 17, "bold")).pack(anchor="w", padx=24, pady=(16, 0))
        tk.Label(header, text="여러 카테고리를 한번에, 중복 없이, 할인율 높은 순으로 엑셀에 담아드려요",
                 bg=TOSS_BLUE, fg="#e3edff", font=("Malgun Gothic", 10)).pack(anchor="w", padx=24)

        canvas = tk.Canvas(self, bg=BG, highlightthickness=0)
        scrollbar = ttk.Scrollbar(self, orient="vertical", command=canvas.yview)
        wrap = ttk.Frame(canvas, padding=24)
        wrap.bind("<Configure>", lambda e: canvas.configure(scrollregion=canvas.bbox("all")))
        canvas.create_window((0, 0), window=wrap, anchor="nw", width=700)
        canvas.configure(yscrollcommand=scrollbar.set)
        canvas.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")

        # ── URL 입력 (5개 각각) ──
        ttk.Label(wrap, text="토스 쉐어링크 목록 페이지 주소  (필요한 만큼만 채우면 돼요)", style="Field.TLabel").pack(anchor="w")
        self.url_entries = []
        for i in range(5):
            row = ttk.Frame(wrap)
            row.pack(fill="x", pady=(6 if i == 0 else 4, 0))
            ttk.Label(row, text=f"링크 {i + 1}", style="Sub.TLabel", width=8).pack(side="left")
            entry = tk.Entry(row, font=("Malgun Gothic", 10), relief="solid", bd=1, highlightthickness=0)
            entry.pack(side="left", fill="x", expand=True, ipady=5)
            self.url_entries.append(entry)

        ttk.Frame(wrap, height=10).pack()

        # ── 최소 할인율 ──
        ttk.Label(wrap, text="최소 할인율(%)  —  비워두면 전체 상품", style="Field.TLabel").pack(anchor="w")
        self.discount_entry = tk.Entry(wrap, font=("Malgun Gothic", 10), relief="solid", bd=1,
                                        width=10, highlightthickness=0)
        self.discount_entry.pack(anchor="w", pady=(6, 14), ipady=6)

        # ── 중복 제거 체크박스 ──
        ttk.Checkbutton(wrap, text="이전에 뽑았던 상품은 빼고, 새 상품만 담기 (중복 제거)",
                         variable=self.dedupe_var, style="Check.TCheckbutton").pack(anchor="w", pady=(0, 18))

        # ── 구글 시트 업로드(선택) ──
        ttk.Label(wrap, text="구글 시트에도 올리기 (선택 — 비워두면 엑셀 파일만 저장)", style="Field.TLabel").pack(anchor="w")
        gs_row = ttk.Frame(wrap)
        gs_row.pack(fill="x", pady=(6, 18))
        ttk.Label(gs_row, text="시트 ID", style="Sub.TLabel").grid(row=0, column=0, sticky="w")
        self.sheet_id_entry = tk.Entry(gs_row, font=("Malgun Gothic", 10), relief="solid", bd=1,
                                        highlightthickness=0)
        self.sheet_id_entry.grid(row=0, column=1, sticky="ew", padx=(8, 0), ipady=5)
        gs_row.columnconfigure(1, weight=1)
        ttk.Label(wrap, text="(구글시트 업로드를 쓰려면 사용법.md의 '구글 시트 연동' 부분을 먼저 봐주세요)",
                  style="Sub.TLabel").pack(anchor="w", pady=(2, 0))

        # ── 쇼핑 갤러리 사이트에 바로 올리기(선택) ──
        ttk.Label(wrap, text="쇼핑 갤러리 사이트에 바로 올리기 (선택 — 엑셀 파일 안 거치고 바로 반영)",
                  style="Field.TLabel").pack(anchor="w", pady=(14, 0))
        site_cfg = core.load_site_config(SITE_CONFIG_PATH)
        self.upload_site_var = tk.BooleanVar(value=bool(site_cfg.get("site_url")))
        ttk.Checkbutton(wrap, text="이번 결과를 사이트 관리자 서버로도 전송하기",
                         variable=self.upload_site_var, style="Check.TCheckbutton").pack(anchor="w", pady=(6, 6))

        site_row = ttk.Frame(wrap)
        site_row.pack(fill="x")
        ttk.Label(site_row, text="사이트 주소", style="Sub.TLabel", width=10).grid(row=0, column=0, sticky="w")
        self.site_url_entry = tk.Entry(site_row, font=("Malgun Gothic", 10), relief="solid", bd=1,
                                        highlightthickness=0)
        self.site_url_entry.grid(row=0, column=1, sticky="ew", padx=(8, 0), ipady=5)
        self.site_url_entry.insert(0, site_cfg.get("site_url", ""))
        site_row.columnconfigure(1, weight=1)

        cred_row = ttk.Frame(wrap)
        cred_row.pack(fill="x", pady=(6, 0))
        ttk.Label(cred_row, text="관리자 아이디", style="Sub.TLabel", width=10).grid(row=0, column=0, sticky="w")
        self.admin_user_entry = tk.Entry(cred_row, font=("Malgun Gothic", 10), relief="solid", bd=1,
                                          highlightthickness=0)
        self.admin_user_entry.grid(row=0, column=1, sticky="ew", padx=(8, 0), ipady=5)
        self.admin_user_entry.insert(0, site_cfg.get("admin_user", ""))
        cred_row.columnconfigure(1, weight=1)

        pw_row = ttk.Frame(wrap)
        pw_row.pack(fill="x", pady=(6, 0))
        ttk.Label(pw_row, text="비밀번호", style="Sub.TLabel", width=10).grid(row=0, column=0, sticky="w")
        self.admin_password_entry = tk.Entry(pw_row, font=("Malgun Gothic", 10), relief="solid", bd=1,
                                              highlightthickness=0, show="*")
        self.admin_password_entry.grid(row=0, column=1, sticky="ew", padx=(8, 0), ipady=5)
        self.admin_password_entry.insert(0, site_cfg.get("admin_password", ""))
        pw_row.columnconfigure(1, weight=1)

        ttk.Label(wrap, text="(사이트 주소는 레일웨이에서 만든 주소, 아이디/비밀번호는 관리자 페이지 로그인 정보와 같아요)",
                  style="Sub.TLabel").pack(anchor="w", pady=(4, 0))

        # ── 1단계 버튼 ──
        ttk.Label(wrap, text="1단계", style="Step.TLabel").pack(anchor="w", pady=(18, 2))
        self.login_btn = ttk.Button(wrap, text="브라우저 열고 로그인하기", style="Blue.TButton",
                                     command=self.on_open_browser)
        self.login_btn.pack(fill="x")

        # ── 2단계 버튼 ──
        ttk.Label(wrap, text="2단계  (로그인 후 눌러주세요)", style="Step.TLabel").pack(anchor="w", pady=(14, 2))
        self.start_btn = ttk.Button(wrap, text="상품 가져오기 시작", style="Blue.TButton",
                                     command=self.on_start_scrape, state="disabled")
        self.start_btn.pack(fill="x")

        # ── 로그 ──
        ttk.Label(wrap, text="진행 상황", style="Field.TLabel").pack(anchor="w", pady=(20, 4))
        log_frame = tk.Frame(wrap, bg="white", highlightbackground=BORDER, highlightthickness=1)
        log_frame.pack(fill="both", expand=True)
        self.log_text = tk.Text(log_frame, bg="white", fg=TEXT_DARK, relief="flat",
                                 font=("Consolas", 9), wrap="word", height=14, state="disabled")
        self.log_text.pack(fill="both", expand=True, padx=10, pady=10)

        self.open_folder_btn = ttk.Button(wrap, text="결과 파일 폴더 열기", style="Grey.TButton",
                                           command=self.open_result_folder, state="disabled")
        self.open_folder_btn.pack(fill="x", pady=(14, 0))

    def log(self, msg):
        def _append():
            self.log_text.configure(state="normal")
            self.log_text.insert("end", msg + "\n")
            self.log_text.see("end")
            self.log_text.configure(state="disabled")
        self.after(0, _append)

    # ── 1단계 + 2단계 (playwright는 반드시 같은 스레드에서만 다뤄야 해서,
    #    브라우저 열기 → 로그인 대기 → 실제 스크래핑까지 하나의 스레드 안에서 이어서 처리함) ──
    def on_open_browser(self):
        urls = self._get_urls()
        if not urls:
            messagebox.showwarning("확인", "링크 주소를 넣어주세요.")
            return
        self.login_btn.configure(state="disabled")
        self.log("브라우저를 여는 중이에요. 잠시만 기다려주세요...")
        self._start_event = threading.Event()
        self._pending_params = None
        threading.Thread(target=self._worker_main, args=(urls[0],), daemon=True).start()

    def _get_urls(self):
        return [e.get().strip() for e in self.url_entries if e.get().strip()]

    def on_start_scrape(self):
        if not self.page:
            messagebox.showwarning("확인", "먼저 1단계로 브라우저를 열고 로그인해주세요.")
            return
        urls = self._get_urls()
        min_discount_text = self.discount_entry.get().strip()
        min_discount = None
        if min_discount_text:
            digits = re.sub(r"[^0-9]", "", min_discount_text)
            min_discount = int(digits) if digits else None
        sheet_id = self.sheet_id_entry.get().strip()
        upload_site = self.upload_site_var.get()
        site_url = self.site_url_entry.get().strip()
        admin_user = self.admin_user_entry.get().strip()
        admin_password = self.admin_password_entry.get()

        self._pending_params = {
            "urls": urls,
            "min_discount": min_discount,
            "sheet_id": sheet_id,
            "dedupe": self.dedupe_var.get(),
            "upload_site": upload_site,
            "site_url": site_url,
            "admin_user": admin_user,
            "admin_password": admin_password,
        }
        self.start_btn.configure(state="disabled")
        self._start_event.set()  # 대기 중이던 워커 스레드를 깨워서 다음 단계로 진행시킴

    def _worker_main(self, first_url):
        try:
            self.playwright = sync_playwright().start()
            try:
                self.context = self.playwright.chromium.launch_persistent_context(
                    USER_DATA_DIR, headless=False, permissions=["clipboard-read", "clipboard-write"],
                )
            except Exception as e:
                if "Executable doesn't exist" in str(e) or "playwright install" in str(e):
                    core.ensure_chromium_installed(self.log)
                    self.context = self.playwright.chromium.launch_persistent_context(
                        USER_DATA_DIR, headless=False, permissions=["clipboard-read", "clipboard-write"],
                    )
                else:
                    raise
            self.page = self.context.pages[0] if self.context.pages else self.context.new_page()
            try:
                self.page.goto(first_url, wait_until="domcontentloaded")
            except Exception as e:
                self.log(f"(참고) 페이지 이동 중 알림: {e}")
            self.log("브라우저 창에서 로그인이 안 되어 있다면 로그인해주세요.")
            self.log("상품 목록이 화면에 보이면 아래 '상품 가져오기 시작' 버튼을 눌러주세요.")
            self.after(0, lambda: self.start_btn.configure(state="normal"))

            self._start_event.wait()  # '2단계' 버튼을 누를 때까지 같은 스레드에서 대기
            params = self._pending_params

            out_path = BASE_DIR / "결과.xlsx"
            all_products = []
            for i, url in enumerate(params["urls"]):
                self.log(f"\n[{i + 1}/{len(params['urls'])}번째 페이지]")
                products = core.scrape_one_page(self.page, url, params["min_discount"], self.log)
                all_products.extend(products)

            if params["dedupe"]:
                seen = core.load_seen_names(SEEN_PATH)
                before = len(all_products)
                all_products = core.remove_already_seen(all_products, seen)
                self.log(f"\n중복 제거: {before}개 → {len(all_products)}개 (새 상품만 남김)")

            if not all_products:
                self.log("담을 상품이 없어요. (모두 이전에 이미 추출한 상품일 수 있어요)")
                self.after(0, self._finish, False, "새로 담을 상품이 없어요.")
                return

            all_products = core.sort_by_discount_desc(all_products)
            core.save_excel(all_products, out_path)
            self.log(f"\n엑셀 저장 완료: {out_path}")

            if params["dedupe"]:
                seen = core.load_seen_names(SEEN_PATH)
                seen.update(p.get("name") for p in all_products if p.get("name"))
                core.save_seen_names(SEEN_PATH, seen)

            if params["sheet_id"]:
                cred_path = BASE_DIR / "google_credentials.json"
                self.log("\n구글 시트에 업로드하는 중...")
                core.upload_to_google_sheet(all_products, str(cred_path), params["sheet_id"], self.log)

            if params["upload_site"] and params["site_url"]:
                self.log("\n쇼핑 갤러리 사이트로 바로 올리는 중...")
                ok = core.upload_to_gallery(
                    all_products, params["site_url"], params["admin_user"], params["admin_password"], self.log
                )
                if ok:
                    core.save_site_config(
                        SITE_CONFIG_PATH, params["site_url"], params["admin_user"], params["admin_password"]
                    )

            self.after(0, self._finish, True, str(out_path))
        except Exception as e:
            self.log(f"\n오류가 발생했어요: {e}")
            self.after(0, self._finish, False, str(e))
            self.after(0, lambda: self.login_btn.configure(state="normal"))

    def _finish(self, success, info):
        self.start_btn.configure(state="normal")
        if success:
            self.result_path = info
            self.open_folder_btn.configure(state="normal")
            messagebox.showinfo("완료", f"엑셀 파일로 저장했어요!\n\n{info}")
        else:
            messagebox.showerror("확인", info)

    def open_result_folder(self):
        if not self.result_path:
            return
        folder = str(Path(self.result_path).resolve().parent)
        try:
            if sys.platform.startswith("win"):
                subprocess.run(["explorer", folder])
            elif sys.platform == "darwin":
                subprocess.run(["open", folder])
            else:
                subprocess.run(["xdg-open", folder])
        except Exception:
            pass


if __name__ == "__main__":
    app = App()
    app.mainloop()
