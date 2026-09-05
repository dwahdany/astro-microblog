#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.13"
# dependencies = [
#   "mcp>=2,<3",
#   "httpx>=0.27",
# ]
# ///
"""
Interactive Brokers connector for the portfolio decision log.

Pulls Activity Flex Query reports from IBKR's Flex Web Service and drops them
into `private/` (gitignored), where scripts/import-ib.mjs turns them into
weight-only draft entries. Runs as a stdio MCP server (the default, wired up in
.mcp.json so Claude Code can call it) or as a plain CLI.

    uv run --script scripts/ibkr-flex-mcp.py status
    uv run --script scripts/ibkr-flex-mcp.py fetch [--from 2026-08-12] [--to 2026-09-04]
    uv run --script scripts/ibkr-flex-mcp.py summarize private/flex_U123_20260812_20260904.xml
    uv run --script scripts/ibkr-flex-mcp.py import [--write] [--force]

ONE-TIME SETUP (Client Portal, https://www.interactivebrokers.com)
    1. Performance & Reports > Flex Queries > Flex Web Service Configuration
       (gear icon): enable it and Generate A New Token. Set "Should Expire
       After" to 1 year — the default is 6 hours. Leave "Valid For IP Address"
       blank unless your IP is static (error 1013 otherwise).
    2. Performance & Reports > Flex Queries > Activity Flex Query > "+":
       - Sections: Account Information (Currency), Change in NAV (TWR),
         Open Positions (Summary; include Symbol, Quantity, Position Value,
         Currency), Trades (Orders — and Executions if you like; include
         Symbol, Date/Time, Quantity, Asset Category, Currency),
         Transfers (Symbol, Date, Direction, Quantity, Type, Asset Category),
         Financial Instrument Information (Symbol, Description, ISIN,
         Listing Exchange, Asset Category).
       - Delivery: Format XML. Period: anything — this script always sends an
         explicit date range (on the v3 endpoint a saved "Last N days" period
         is not honoured reliably).
       - The Query ID is in the (i) info pop-over next to the saved query.
    3. Put both values where only you can read them, never in git:
         private/ibkr.env
           IBKR_FLEX_TOKEN=...
           IBKR_FLEX_QUERY_ID=...
           IBKR_FLEX_TOKEN_CREATED=2026-09-05   # optional; enables the expiry warning
       (plain environment variables work too and take precedence).

FIRST RUN — do this once, interactively, before trusting anything:
    fetch --from 2026-01-01 --to 2026-08-11, then `import`: the Flex report must
    verify against the same period-end snapshot as the hand-downloaded CSV, its
    TWR must match the CSV's "Time Weighted Rate of Return", and one trade's
    Date/Time must agree to the second across both files (the deduplication
    relies on it). Only then delete or keep the CSVs — both work.

The Flex Web Service is IBKR's supported, token-based way to fetch reports
without a running gateway or a browser login. Activity data is finalised once a
day after the close, so `to_date` defaults to yesterday; fetch the morning after. Pacing is 1 request/s and 10/min
per token; this script stays well inside that.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

import httpx

# ---------------------------------------------------------------- locations
HERE = Path(__file__).resolve().parent
REPO = HERE.parent
PRIVATE_DIR = Path(os.environ.get("IBKR_PRIVATE_DIR") or REPO / "private")
ENV_FILE = PRIVATE_DIR / "ibkr.env"
IMPORT_SCRIPT = HERE / "import-ib.mjs"
PORTFOLIO_CONFIG = REPO / "src" / "data" / "portfolio.config.ts"

# Everything this process says goes to stderr: stdout is the MCP transport.
logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="ibkr-flex: %(message)s")
log = logging.getLogger("ibkr-flex")
logging.getLogger("httpx").setLevel(logging.WARNING)  # its INFO line would echo the token

# ------------------------------------------------------------------ config
def load_env_file(path: Path) -> bool:
    """KEY=VALUE lines; the process environment wins over the file."""
    if not path.exists():
        return False
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value
    return True


ENV_FILE_LOADED = load_env_file(ENV_FILE)


def token() -> str | None:
    return os.environ.get("IBKR_FLEX_TOKEN") or None


def default_query_id() -> str | None:
    return os.environ.get("IBKR_FLEX_QUERY_ID") or None


def token_age_warning() -> str | None:
    """IBKR tokens live at most a year and expire without notice; warn from month eleven."""
    created = os.environ.get("IBKR_FLEX_TOKEN_CREATED")
    if not created:
        return None
    try:
        age = (date.today() - date.fromisoformat(created)).days
    except ValueError:
        return f"IBKR_FLEX_TOKEN_CREATED={created!r} is not YYYY-MM-DD"
    return f"Token is {age} days old; IBKR tokens expire after at most a year — regenerate soon." if age > 335 else None


def inception_date() -> str | None:
    """The track record start from portfolio.config.ts, if it declares one."""
    try:
        m = re.search(r"inception:\s*'(\d{4}-\d{2}-\d{2})'", PORTFOLIO_CONFIG.read_text())
        return m.group(1) if m else None
    except OSError:
        return None


# ---------------------------------------------------------- flex protocol
# Overridable so the protocol can be exercised against a local stand-in in tests.
SEND_URL = os.environ.get("IBKR_FLEX_SEND_URL", "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest")
GET_URL = os.environ.get("IBKR_FLEX_GET_URL", "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement")
MAX_WINDOW_DAYS = 365  # a single Flex request may span at most a year

# IBKR's documented Flex Web Service error codes.
FLEX_ERRORS = {
    "1001": "Statement could not be generated at this time. Please try again shortly.",
    "1003": "Statement is not available.",
    "1004": "Statement is incomplete at this time. Please try again shortly.",
    "1005": "Settlement data is not ready at this time. Please try again shortly.",
    "1006": "FIFO P/L data is not ready at this time. Please try again shortly.",
    "1007": "MTM P/L data is not ready at this time. Please try again shortly.",
    "1008": "MTM and FIFO P/L data is not ready at this time. Please try again shortly.",
    "1009": "The server is under heavy load. Statement could not be generated at this time. Please try again shortly.",
    "1010": "Legacy Flex Queries are no longer supported. Please convert over to Activity Flex.",
    "1011": "Service account is inactive.",
    "1012": "Token has expired.",
    "1013": "IP restriction.",
    "1014": "Query is invalid.",
    "1015": "Token is invalid.",
    "1016": "Account in invalid.",
    "1017": "Reference code is invalid.",
    "1018": "Too many requests have been made from this token. Please try again shortly.",
    "1019": "Statement generation in progress. Please try again shortly.",
    "1020": "Invalid request or unable to validate request.",
    "1021": "Statement could not be retrieved at this time. Please try again shortly.",
}
RETRY_LATER = {"1001", "1004", "1005", "1006", "1007", "1008", "1009", "1019", "1021"}
THROTTLED = {"1018"}
TOKEN_ERRORS = {"1012", "1013", "1015"}


class FlexError(RuntimeError):
    def __init__(self, code: str | None, message: str):
        self.code = code
        super().__init__(f"IBKR Flex {code or 'error'}: {message}" if code else message)


@dataclass
class FlexResponseStatus:
    ok: bool
    reference_code: str | None = None
    url: str | None = None
    error_code: str | None = None
    error_message: str | None = None


def parse_status(text: str) -> FlexResponseStatus | None:
    """The small `<FlexStatementResponse>` envelope; None if `text` is a report."""
    head = text.lstrip()[:200]
    if "<FlexStatementResponse" not in head:
        return None
    root = ET.fromstring(text)
    # IBKR's docs show <url> in one place and <Url> in another; match tags case-insensitively.
    fields = {child.tag.lower(): (child.text or "").strip() for child in root}
    status = fields.get("status", "")
    code = fields.get("errorcode") or None
    msg = fields.get("errormessage") or FLEX_ERRORS.get(code or "", "") or None
    if code in TOKEN_ERRORS:
        msg = f"{msg} Regenerate the token in Client Portal > Performance & Reports > Flex Queries > Flex Web Service Configuration and update {ENV_FILE}."
    return FlexResponseStatus(
        ok=status.lower() == "success" and not code,
        reference_code=fields.get("referencecode") or None,
        url=fields.get("url") or None,
        error_code=code,
        error_message=msg,
    )


async def flex_download(
    client: httpx.AsyncClient,
    tok: str,
    query_id: str,
    fd: str | None,
    td: str | None,
    max_wait_seconds: int,
) -> str:
    """Two-step download: SendRequest → poll GetStatement until the report is ready."""
    params: dict[str, str] = {"v": "3", "t": tok, "q": query_id}
    if fd and td:
        params["fd"], params["td"] = fd, td
    r = await client.get(SEND_URL, params=params)
    r.raise_for_status()
    st = parse_status(r.text)
    if st is None:
        raise FlexError(None, f"Unexpected SendRequest response: {r.text[:200]!r}")
    if not st.ok or not st.reference_code:
        raise FlexError(st.error_code, st.error_message or "SendRequest failed")

    # IBKR sometimes answers with a GetStatement URL on a sibling host (gdcdyn);
    # follow it, but never send the token anywhere that is not IBKR.
    get_url = GET_URL
    if st.url and (httpx.URL(st.url).host or "").endswith(".interactivebrokers.com"):
        get_url = st.url
    elif st.url and os.environ.get("IBKR_FLEX_GET_URL"):
        get_url = GET_URL  # test stand-in
    waited = 0.0
    delays = [3, 5, 10, 15, 20, 30]
    attempt = 0
    while True:
        r = await client.get(get_url, params={"v": "3", "t": tok, "q": st.reference_code})
        r.raise_for_status()
        st2 = parse_status(r.text)
        if st2 is None:
            if not r.text.lstrip().startswith("<FlexQueryResponse"):
                raise FlexError(None, f"GetStatement returned something that is not a Flex XML report "
                                      f"(is the query's format set to XML?): {r.text.lstrip()[:160]!r}")
            return r.text  # the report itself
        if st2.error_code in RETRY_LATER or st2.error_code in THROTTLED:
            delay = delays[min(attempt, len(delays) - 1)]
            if st2.error_code in THROTTLED:
                delay = max(delay, 30)
            if waited + delay > max_wait_seconds:
                raise FlexError(
                    st2.error_code,
                    f"{st2.error_message} (gave up after {int(waited)}s; the report may still finish — "
                    f"retry in a minute, or raise max_wait_seconds)",
                )
            log.info("waiting %ss (%s %s)", delay, st2.error_code, st2.error_message)
            await asyncio.sleep(delay)
            waited += delay
            attempt += 1
            continue
        raise FlexError(st2.error_code, st2.error_message or "GetStatement failed")


# --------------------------------------------------------------- reports
DATE_RE = re.compile(r"\D")


def iso(d: str | None) -> str | None:
    """`20260811`, `2026-08-11`, `2026-08-11;09:30:00` -> `2026-08-11`."""
    digits = DATE_RE.sub("", d or "")
    return f"{digits[:4]}-{digits[4:6]}-{digits[6:8]}" if len(digits) >= 8 else None


def compact(d: str) -> str:
    return d.replace("-", "")


def mask(account_id: str | None) -> str:
    if not account_id:
        return "?"
    return account_id[:1] + "…" + account_id[-3:] if len(account_id) > 4 else "…"


@dataclass
class FlexSummary:
    account: str
    from_date: str | None
    to_date: str | None
    generated: str | None
    base_currency: str | None
    twr_percent: str | None
    counts: dict[str, int]
    orders: list[dict[str, str]]
    transfers: list[dict[str, str]]
    warnings: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return self.__dict__


def summarize_flex(text: str) -> FlexSummary:
    """What the report contains — shapes and dates only, never sizes or values."""
    root = ET.fromstring(text)
    warnings: list[str] = []
    if root.tag != "FlexQueryResponse":
        raise FlexError(None, f"Not a Flex report (root element <{root.tag}>)")
    if root.get("type") not in (None, "AF"):
        warnings.append(f"query type is {root.get('type')!r}; expected an Activity Flex Query (AF)")
    stmts = root.findall(".//FlexStatement")
    if not stmts:
        msg = root.findtext(".//Message") or "no FlexStatement in response"
        raise FlexError(None, msg)

    counts = {"statements": len(stmts), "orders": 0, "executions": 0, "transfers": 0,
              "open_positions": 0, "securities": 0}
    orders: list[dict[str, str]] = []
    transfers: list[dict[str, str]] = []
    base_ccy = twr = None
    for s in stmts:
        acct = s.find("AccountInformation")
        if acct is not None and acct.get("currency"):
            base_ccy = acct.get("currency")
        nav = s.find("ChangeInNAV")
        if nav is not None and nav.get("twr"):
            twr = nav.get("twr")
        for o in s.findall(".//Trades/Order"):
            counts["orders"] += 1
            if (o.get("assetCategory") or "") == "CASH":
                continue
            q = o.get("quantity") or ""
            orders.append({
                "date": iso(o.get("dateTime") or o.get("tradeDate")) or "?",
                "symbol": o.get("symbol") or "?",
                "side": "sell" if q.startswith("-") else "buy",
            })
        counts["executions"] += len(s.findall(".//Trades/Trade"))
        for t in s.findall(".//Transfers/Transfer"):
            if not t.get("symbol"):
                continue  # cash transfers carry no position
            counts["transfers"] += 1
            transfers.append({
                "date": iso(t.get("date") or t.get("reportDate") or t.get("dateTime")) or "?",
                "symbol": t.get("symbol") or "?",
                "direction": (t.get("direction") or "?").lower(),
                "type": t.get("type") or "",
            })
        counts["open_positions"] += len([p for p in s.findall(".//OpenPositions/OpenPosition")
                                         if p.get("levelOfDetail") != "LOT"])
        counts["securities"] += len(s.findall(".//SecuritiesInfo/SecurityInfo"))
        if s.find("OpenPositions") is None:
            warnings.append("no Open Positions section — the importer cannot verify the reconstruction")
        if nav is None or not nav.get("twr"):
            warnings.append("no Change in NAV / TWR — the return cross-check will be skipped")
        if not s.findall(".//Trades/Order") and s.findall(".//Trades/Trade"):
            warnings.append("Trades section has executions but no orders — enable 'Orders' so overlapping files deduplicate")
        if acct is None or not acct.get("currency"):
            warnings.append("no Account Information / base currency — the importer will assume EUR")

    froms = sorted(filter(None, (iso(s.get("fromDate")) for s in stmts)))
    tos = sorted(filter(None, (iso(s.get("toDate")) for s in stmts)))
    return FlexSummary(
        account=mask(stmts[0].get("accountId")),
        from_date=froms[0] if froms else None,
        to_date=tos[-1] if tos else None,
        generated=stmts[0].get("whenGenerated"),
        base_currency=base_ccy,
        twr_percent=twr,
        counts=counts,
        orders=sorted(orders, key=lambda o: o["date"]),
        transfers=sorted(transfers, key=lambda t: t["date"]),
        warnings=sorted(set(warnings)),
    )


MONTHS = {m: i for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july", "august",
     "september", "october", "november", "december"], start=1)}


def long_date(s: str) -> str | None:
    m = re.match(r"^\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s*$", s)
    if not m or m.group(1).lower() not in MONTHS:
        return None
    return f"{m.group(3)}-{MONTHS[m.group(1).lower()]:02d}-{int(m.group(2)):02d}"


def statement_period(path: Path) -> tuple[str | None, str | None, str]:
    """(from, to, format) of one file in private/, from its own header."""
    text = path.read_text(errors="replace")
    if text.lstrip().startswith("<"):
        try:
            root = ET.fromstring(text)
            stmts = root.findall(".//FlexStatement")
            froms = sorted(filter(None, (iso(s.get("fromDate")) for s in stmts)))
            tos = sorted(filter(None, (iso(s.get("toDate")) for s in stmts)))
            return (froms[0] if froms else None, tos[-1] if tos else None, "flex-xml")
        except ET.ParseError:
            return (None, None, "xml?")
    m = re.search(r'^Statement,Data,Period,"?([^"\n]+?)"?\r?$', text, re.M)
    if m:
        parts = [p.strip() for p in m.group(1).split(" - ")]
        if len(parts) == 2:
            return (long_date(parts[0]), long_date(parts[1]), "statement-csv")
        if len(parts) == 1 and long_date(parts[0]):
            return (long_date(parts[0]), long_date(parts[0]), "statement-csv")
    m = re.search(r"(\d{8})[-_](\d{8})\.csv$", path.name) or re.search(r"_(\d{4})_(\d{4})\.csv$", path.name)
    if m and len(m.group(1)) == 8:
        return (iso(m.group(1)), iso(m.group(2)), "statement-csv")
    if m:
        return (f"{m.group(1)}-01-01", f"{m.group(2)}-12-31", "statement-csv")
    return (None, None, "statement-csv")


def covered_files() -> list[dict[str, Any]]:
    out = []
    if not PRIVATE_DIR.exists():
        return out
    for p in sorted(PRIVATE_DIR.iterdir()):
        if p.suffix.lower() not in (".csv", ".xml") or p.name.startswith("."):
            continue
        f, t, fmt = statement_period(p)
        out.append({"file": p.name, "from": f, "to": t, "format": fmt})
    return out


def latest_covered() -> str | None:
    tos = [c["to"] for c in covered_files() if c["to"]]
    return max(tos) if tos else None


def windows(from_date: str, to_date: str) -> list[tuple[str, str]]:
    """Split a range into contiguous chunks of at most MAX_WINDOW_DAYS."""
    start, end = date.fromisoformat(from_date), date.fromisoformat(to_date)
    if start > end:
        raise ValueError(f"from_date {from_date} is after to_date {to_date}")
    out = []
    while start <= end:
        stop = min(start + timedelta(days=MAX_WINDOW_DAYS - 1), end)
        out.append((start.isoformat(), stop.isoformat()))
        start = stop + timedelta(days=1)
    return out


# --------------------------------------------------------------- actions
def status_report() -> dict[str, Any]:
    files = covered_files()
    latest = latest_covered()
    return {
        "configured": {
            "token": bool(token()),
            "query_id": bool(default_query_id()),
            "source": "environment" if (token() and not ENV_FILE_LOADED) else (str(ENV_FILE) if ENV_FILE_LOADED else None),
        },
        "private_dir": str(PRIVATE_DIR),
        "files": files,
        "latest_covered_date": latest,
        "inception": inception_date(),
        "next_fetch": {
            "from": (date.fromisoformat(latest) + timedelta(days=1)).isoformat() if latest else inception_date(),
            "to": (date.today() - timedelta(days=1)).isoformat(),
        },
        "token_age_warning": token_age_warning(),
        "setup_hint": None if (token() and default_query_id()) else (
            "Set " + " and ".join(k for k, v in (("IBKR_FLEX_TOKEN", token()), ("IBKR_FLEX_QUERY_ID", default_query_id())) if not v)
            + f" in {ENV_FILE} (see the header of {Path(__file__).name})."
        ),
    }


async def fetch_activity_impl(
    from_date: str | None,
    to_date: str | None,
    query_id: str | None,
    max_wait_seconds: int,
) -> dict[str, Any]:
    tok, qid = token(), (query_id or default_query_id())
    if not tok or not qid:
        raise FlexError(None, f"Not configured: put IBKR_FLEX_TOKEN and IBKR_FLEX_QUERY_ID in {ENV_FILE}")
    to_date = to_date or (date.today() - timedelta(days=1)).isoformat()
    if not from_date:
        latest = latest_covered()
        from_date = (date.fromisoformat(latest) + timedelta(days=1)).isoformat() if latest else inception_date()
    if not from_date:
        raise FlexError(None, "No from_date given, nothing in private/ to continue from, and no inception in portfolio.config.ts")
    if from_date > to_date:
        return {"files": [], "note": f"Nothing to fetch: private/ already covers through {latest_covered()}."}

    PRIVATE_DIR.mkdir(parents=True, exist_ok=True)
    results = []
    async with httpx.AsyncClient(timeout=60, headers={"User-Agent": "blog-portfolio-log/1.0 (+ibkr-flex-mcp)"}) as client:
        for i, (fd, td) in enumerate(windows(from_date, to_date)):
            if i:
                await asyncio.sleep(5)  # one query at a time keeps the token out of 1018 territory
            log.info("requesting %s..%s", fd, td)
            text = await flex_download(client, tok, qid, compact(fd), compact(td), max_wait_seconds)
            summary = summarize_flex(text)
            if summary.from_date != fd or summary.to_date != td:
                note = f"IBKR returned {summary.from_date}..{summary.to_date} for a request of {fd}..{td}"
                if summary.from_date == summary.to_date and fd != td:
                    raise FlexError(None, f"{note}: the period collapsed to one day. Pass the date range explicitly "
                                          f"(this script does) and check the saved query in Client Portal.")
                summary.warnings.append(note)
            acct = re.sub(r"[^A-Za-z0-9]", "", ET.fromstring(text).find(".//FlexStatement").get("accountId") or "acct")
            name = f"flex_{acct}_{compact(summary.from_date or fd)}_{compact(summary.to_date or td)}.xml"
            path = PRIVATE_DIR / name
            path.write_text(text)
            log.info("saved %s", path)
            results.append({"path": str(path), "requested": {"from": fd, "to": td}, **summary.as_dict()})
    return {
        "files": results,
        "next_step": "run_import() (or: node scripts/import-ib.mjs private/*) to verify the reconstruction and draft entries",
    }


def run_import_impl(write: bool, force: bool) -> dict[str, Any]:
    node = shutil.which("node")
    if not node:
        raise FlexError(None, "node is not on PATH for this process; run `node scripts/import-ib.mjs private/*` from a shell instead")
    files = sorted(str(p) for p in PRIVATE_DIR.glob("*") if p.suffix.lower() in (".csv", ".xml"))
    if not files:
        raise FlexError(None, f"No statements in {PRIVATE_DIR}; fetch first")
    cmd = [node, str(IMPORT_SCRIPT), *files] + (["--write"] if write else []) + (["--force"] if force else [])
    proc = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True, timeout=300)
    return {
        "command": f"node scripts/import-ib.mjs private/* {'--write ' if write else ''}{'--force' if force else ''}".strip(),
        "exit_code": proc.returncode,
        "output": (proc.stdout + proc.stderr).strip(),
    }


# -------------------------------------------------------------- MCP server
def build_server():
    from mcp.server.mcpserver import MCPServer
    from mcp.server.mcpserver.exceptions import ToolError
    from mcp.types import ToolAnnotations

    READ_ONLY = ToolAnnotations(read_only_hint=True, open_world_hint=False)

    server = MCPServer(
        "ibkr",
        instructions=(
            "Read-only connector to the user's Interactive Brokers account via the Flex Web Service. "
            "fetch_activity pulls Activity Flex reports into private/ (gitignored); run_import turns them "
            "into weight-only draft entries under src/content/portfolio/. Never paste report contents into "
            "committed files — the published log carries weights, not amounts."
        ),
        version="1.0.0",
    )

    async def guarded(coro):
        """Turn connector failures into tool errors the model can read and act on."""
        try:
            return await coro
        except FlexError as e:
            raise ToolError(str(e)) from e
        except httpx.HTTPError as e:
            raise ToolError(f"HTTP error talking to IBKR: {e}") from e

    async def _status() -> dict[str, Any]:
        return status_report()

    async def _summarize(path: str) -> dict[str, Any]:
        p = Path(path)
        if not p.is_absolute():
            p = (REPO / p) if (REPO / p).exists() else PRIVATE_DIR / p
        if not p.exists():
            raise FlexError(None, f"No such file: {p}")
        text = p.read_text(errors="replace")
        if text.lstrip().startswith("<"):
            return {"path": str(p), **summarize_flex(text).as_dict()}
        f, t, fmt = statement_period(p)
        return {"path": str(p), "format": fmt, "from_date": f, "to_date": t}

    @server.tool(annotations=READ_ONLY)
    async def flex_status() -> dict[str, Any]:
        """Is the connector configured, which statements are already in private/,
        and which date range the next fetch would cover. Never returns secrets."""
        return await guarded(_status())

    @server.tool(annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=True, open_world_hint=True))
    async def fetch_activity(
        from_date: str | None = None,
        to_date: str | None = None,
        query_id: str | None = None,
        max_wait_seconds: int = 150,
    ) -> dict[str, Any]:
        """Download Activity Flex report(s) from IBKR into private/ and summarise them.
        Dates are YYYY-MM-DD. Defaults: from_date = the day after the latest statement
        already in private/ (or the track-record inception), to_date = yesterday. Ranges
        longer than a year are fetched as consecutive one-year chunks. Returns file
        paths, the period actually covered, row counts, IBKR's TWR for the period,
        and the dates/symbols/sides of orders and transfers — no quantities or values."""
        return await guarded(fetch_activity_impl(from_date, to_date, query_id, max_wait_seconds))

    @server.tool(annotations=READ_ONLY)
    async def summarize_statement(path: str) -> dict[str, Any]:
        """Summarise one file already in private/ (Flex XML, or the period of a
        hand-downloaded statement CSV) without exposing amounts."""
        return await guarded(_summarize(path))

    @server.tool()
    async def run_import(write: bool = False, force: bool = False) -> dict[str, Any]:
        """Run scripts/import-ib.mjs over everything in private/: reconstructs the
        position ledger, verifies it against IBKR's own snapshots, and (with
        write=true) writes weight-only draft entries to src/content/portfolio/.
        force=true writes even when verification failed."""
        return await guarded(asyncio.to_thread(run_import_impl, write, force))

    return server


# -------------------------------------------------------------------- CLI
def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(prog="ibkr-flex-mcp.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd")
    sub.add_parser("status", help="configuration and coverage")
    f = sub.add_parser("fetch", help="download Flex report(s) into private/")
    f.add_argument("--from", dest="from_date")
    f.add_argument("--to", dest="to_date")
    f.add_argument("--query", dest="query_id")
    f.add_argument("--max-wait", dest="max_wait", type=int, default=150)
    s = sub.add_parser("summarize", help="summarise a downloaded file")
    s.add_argument("path")
    i = sub.add_parser("import", help="run scripts/import-ib.mjs over private/")
    i.add_argument("--write", action="store_true")
    i.add_argument("--force", action="store_true")
    sub.add_parser("serve", help="run as a stdio MCP server (the default with no arguments)")
    args = ap.parse_args(argv)

    if args.cmd in (None, "serve"):
        build_server().run(transport="stdio")
        return 0
    try:
        if args.cmd == "status":
            out = status_report()
        elif args.cmd == "fetch":
            out = asyncio.run(fetch_activity_impl(args.from_date, args.to_date, args.query_id, args.max_wait))
        elif args.cmd == "summarize":
            text = Path(args.path).read_text(errors="replace")
            out = summarize_flex(text).as_dict() if text.lstrip().startswith("<") else dict(zip(("from", "to", "format"), statement_period(Path(args.path))))
        elif args.cmd == "import":
            out = run_import_impl(args.write, args.force)
        else:
            ap.print_help()
            return 2
    except (FlexError, ValueError, httpx.HTTPError) as e:
        print(json.dumps({"error": str(e)}, indent=2))
        return 1
    print(json.dumps(out, indent=2, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
