from __future__ import annotations

import csv
import sqlite3
import sys
import urllib.request
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
CSV_FILE = DATA_DIR / "ecdict.csv"
DB_FILE = DATA_DIR / "dictionary.db"
ECDICT_URL = "https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv"


def download_csv() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if CSV_FILE.exists() and CSV_FILE.stat().st_size > 10_000_000:
        return

    print(f"Downloading ECDICT from {ECDICT_URL}")
    with urllib.request.urlopen(ECDICT_URL, timeout=120) as response:
        with CSV_FILE.open("wb") as file:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                file.write(chunk)


def import_csv(limit: int | None = None) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    temp_db = DB_FILE.with_suffix(".tmp")
    if temp_db.exists():
        temp_db.unlink()

    connection = sqlite3.connect(temp_db)
    try:
        connection.execute(
            """
            CREATE TABLE entries (
              word TEXT PRIMARY KEY,
              phonetic TEXT,
              definition TEXT,
              translation TEXT
            )
            """
        )
        batch = []
        with CSV_FILE.open("r", encoding="utf-8", newline="") as file:
            reader = csv.DictReader(file)
            for index, row in enumerate(reader, start=1):
                word = (row.get("word") or "").strip()
                if not word:
                    continue
                batch.append((
                    word,
                    (row.get("phonetic") or "").strip(),
                    (row.get("definition") or "").strip(),
                    (row.get("translation") or "").strip(),
                ))
                if len(batch) >= 5000:
                    connection.executemany("INSERT OR REPLACE INTO entries VALUES (?, ?, ?, ?)", batch)
                    batch.clear()
                if limit and index >= limit:
                    break
        if batch:
            connection.executemany("INSERT OR REPLACE INTO entries VALUES (?, ?, ?, ?)", batch)

        connection.execute("CREATE INDEX idx_entries_translation ON entries(translation)")
        connection.commit()
    finally:
        connection.close()

    temp_db.replace(DB_FILE)
    print(f"Dictionary saved to {DB_FILE}")


def main() -> None:
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else None
    download_csv()
    import_csv(limit)


if __name__ == "__main__":
    main()
