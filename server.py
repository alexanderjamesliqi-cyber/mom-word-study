from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import sqlite3
import subprocess
from datetime import datetime
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any
from zoneinfo import ZoneInfo

from flask import Flask, jsonify, request, send_from_directory

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
LEGACY_STATE_FILE = DATA_DIR / "state.json"
DICTIONARY_DB = DATA_DIR / "dictionary.db"
TIMEZONE = ZoneInfo(os.environ.get("WORD_APP_TIMEZONE", "Asia/Shanghai"))
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
DEPLOY_SCRIPT = BASE_DIR / "deploy.sh"

app = Flask(__name__, static_folder=None)

WORD_BOOK: dict[str, dict[str, str]] = {
    "apple": {
        "id": "apple",
        "text": "apple",
        "phonetic": "/ˈæpəl/",
        "meaning": "苹果",
        "phrase": "an apple",
        "sentence": "I eat an apple after lunch.",
    },
    "banana": {
        "id": "banana",
        "text": "banana",
        "phonetic": "/bəˈnɑːnə/",
        "meaning": "香蕉",
        "phrase": "a yellow banana",
        "sentence": "The banana is yellow.",
    },
    "school": {
        "id": "school",
        "text": "school",
        "phonetic": "/skuːl/",
        "meaning": "学校",
        "phrase": "go to school",
        "sentence": "I go to school every day.",
    },
    "happy": {
        "id": "happy",
        "text": "happy",
        "phonetic": "/ˈhæpi/",
        "meaning": "开心的",
        "phrase": "feel happy",
        "sentence": "I feel happy today.",
    },
    "window": {
        "id": "window",
        "text": "window",
        "phonetic": "/ˈwɪndoʊ/",
        "meaning": "窗户",
        "phrase": "open the window",
        "sentence": "Please open the window.",
    },
    "pencil": {
        "id": "pencil",
        "text": "pencil",
        "phonetic": "/ˈpensəl/",
        "meaning": "铅笔",
        "phrase": "a sharp pencil",
        "sentence": "I write with a pencil.",
    },
    "friend": {
        "id": "friend",
        "text": "friend",
        "phonetic": "/frend/",
        "meaning": "朋友",
        "phrase": "my best friend",
        "sentence": "My friend plays with me.",
    },
    "family": {
        "id": "family",
        "text": "family",
        "phonetic": "/ˈfæməli/",
        "meaning": "家庭",
        "phrase": "my family",
        "sentence": "I love my family.",
    },
    "water": {
        "id": "water",
        "text": "water",
        "phonetic": "/ˈwɔːtər/",
        "meaning": "水",
        "phrase": "drink water",
        "sentence": "I drink water every day.",
    },
    "book": {
        "id": "book",
        "text": "book",
        "phonetic": "/bʊk/",
        "meaning": "书",
        "phrase": "read a book",
        "sentence": "I read a book at night.",
    },
    "teacher": {
        "id": "teacher",
        "text": "teacher",
        "phonetic": "/ˈtiːtʃər/",
        "meaning": "老师",
        "phrase": "my English teacher",
        "sentence": "My teacher helps me learn.",
    },
    "orange": {
        "id": "orange",
        "text": "orange",
        "phonetic": "/ˈɔːrɪndʒ/",
        "meaning": "橙子",
        "phrase": "an orange",
        "sentence": "The orange tastes sweet.",
    },
}


def today_key() -> str:
    return datetime.now(TIMEZONE).strftime("%Y-%m-%d")


def default_state() -> dict[str, Any]:
    return default_state_for_date(today_key())


def default_state_for_date(date: str) -> dict[str, Any]:
    return {
        "date": date,
        "words": [],
        "progress": {},
    }


def requested_date() -> str:
    date = request.args.get("date", today_key())
    return date if DATE_RE.match(date) else today_key()


def state_file_for_date(date: str) -> Path:
    return DATA_DIR / f"state-{date}.json"


def normalize_state(value: Any, date: str | None = None) -> dict[str, Any]:
    target_date = date or today_key()
    if not isinstance(value, dict):
        return default_state_for_date(target_date)

    state_date = value.get("date") if DATE_RE.match(str(value.get("date", ""))) else target_date
    state = default_state_for_date(state_date)
    state["words"] = value.get("words") if isinstance(value.get("words"), list) else []
    state["progress"] = value.get("progress") if isinstance(value.get("progress"), dict) else {}
    return state


def read_state(date: str | None = None) -> dict[str, Any]:
    target_date = date or today_key()
    state_file = state_file_for_date(target_date)
    if not state_file.exists() and target_date == today_key() and LEGACY_STATE_FILE.exists():
        state_file = LEGACY_STATE_FILE
    if not state_file.exists():
        return default_state_for_date(target_date)

    try:
        with state_file.open("r", encoding="utf-8") as file:
            return normalize_state(json.load(file), target_date)
    except (OSError, json.JSONDecodeError):
        return default_state_for_date(target_date)


def write_state(state: dict[str, Any]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    payload = normalize_state(state)
    state_file = state_file_for_date(payload["date"])

    with NamedTemporaryFile("w", encoding="utf-8", dir=DATA_DIR, delete=False) as file:
        json.dump(payload, file, ensure_ascii=False, indent=2)
        file.write("\n")
        temp_name = file.name

    Path(temp_name).replace(state_file)


def dictionary_lookup(term: str) -> dict[str, str] | None:
    if not DICTIONARY_DB.exists():
        return None
    query = term.strip().lower()
    try:
        with sqlite3.connect(DICTIONARY_DB) as connection:
            connection.row_factory = sqlite3.Row
            row = connection.execute(
                """
                SELECT word, phonetic, translation, definition
                FROM entries
                WHERE lower(word) = ?
                LIMIT 1
                """,
                (query,),
            ).fetchone()
            if row is None:
                row = connection.execute(
                    """
                    SELECT word, phonetic, translation, definition
                    FROM entries
                    WHERE translation LIKE ?
                    ORDER BY length(word)
                    LIMIT 1
                    """,
                    (f"%{term.strip()}%",),
                ).fetchone()
    except sqlite3.Error:
        return None

    if row is None:
        return None

    meaning = first_translation(row["translation"]) or row["definition"] or ""
    word = row["word"]
    return {
        "id": word.lower(),
        "text": word,
        "phonetic": wrap_phonetic(row["phonetic"] or ""),
        "meaning": meaning,
        "phrase": f"use {word}",
        "sentence": make_sentence(word),
    }


def first_translation(value: str) -> str:
    if not value:
        return ""
    first_line = value.splitlines()[0].strip()
    first_part = re.split(r"[;；,，]", first_line)[0].strip()
    return first_part


def wrap_phonetic(value: str) -> str:
    text = value.strip().strip("/")
    return f"/{text}/" if text else ""


def make_sentence(word: str) -> str:
    return f"I can use {word} in a sentence."


def lookup_word(query: str) -> dict[str, str]:
    term = query.strip()
    normalized = term.lower()
    dictionary_item = dictionary_lookup(term)
    if dictionary_item:
        return dictionary_item

    if normalized in WORD_BOOK:
        return WORD_BOOK[normalized]

    for item in WORD_BOOK.values():
        if term == item["meaning"] or term in item["meaning"]:
            return item

    if term.isascii() and term:
        return {
            "id": normalized,
            "text": term,
            "phonetic": "",
            "meaning": "",
            "phrase": f"use {term}",
            "sentence": f"I can use {term} in a sentence.",
        }

    return {
        "id": "",
        "text": "",
        "phonetic": "",
        "meaning": term,
        "phrase": "",
        "sentence": "",
    }


def verify_github_signature(payload: bytes) -> bool:
    secret = os.environ.get("DEPLOY_WEBHOOK_SECRET", "")
    if not secret:
        return False

    signature = request.headers.get("X-Hub-Signature-256", "")
    expected = "sha256=" + hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()
    return hmac.compare_digest(signature, expected)


def trigger_deploy() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    log_file = DATA_DIR / "deploy.log"
    with log_file.open("ab") as log:
        subprocess.Popen(
            ["/bin/bash", str(DEPLOY_SCRIPT)],
            cwd=BASE_DIR,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )


@app.get("/")
def home():
    return send_from_directory(BASE_DIR, "index.html")


@app.get("/child/")
def child():
    return send_from_directory(BASE_DIR / "child", "index.html")


@app.get("/parent/")
def parent():
    return send_from_directory(BASE_DIR / "parent", "index.html")


@app.get("/<path:filename>")
def assets(filename: str):
    return send_from_directory(BASE_DIR, filename)


@app.get("/api/state")
def get_state():
    return jsonify(read_state(requested_date()))


@app.get("/api/lookup")
def lookup():
    query = request.args.get("q", "")
    if not query.strip():
        return jsonify({"error": "q is required"}), 400
    return jsonify(lookup_word(query))


@app.post("/hooks/github")
def github_hook():
    payload = request.get_data()
    if not verify_github_signature(payload):
        return jsonify({"error": "invalid signature"}), 401

    if request.headers.get("X-GitHub-Event") != "push":
        return jsonify({"status": "ignored"})

    body = request.get_json(silent=True) or {}
    if body.get("ref") != "refs/heads/main":
        return jsonify({"status": "ignored", "ref": body.get("ref")})

    trigger_deploy()
    return jsonify({"status": "deploy started"})


@app.put("/api/state")
def put_state():
    incoming = request.get_json(silent=True)
    if incoming is None:
        return jsonify({"error": "JSON body is required"}), 400

    state = normalize_state(incoming, requested_date())
    write_state(state)
    return jsonify(state)


@app.delete("/api/state")
def delete_state():
    state = default_state_for_date(requested_date())
    write_state(state)
    return jsonify(read_state(state["date"]))


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5173"))
    app.run(host="0.0.0.0", port=port, debug=True)
