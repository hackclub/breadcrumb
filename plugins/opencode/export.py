#!/usr/bin/env python3
"""Opt-in OpenCode v2 usage exporter. Requires Python 3.11+; no third-party packages."""

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import time
import unicodedata

IDENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,199}$")
FIELDS = {
    "model.id", "time.completed", "tokens.input", "tokens.output",
    "tokens.reasoning", "tokens.cache.read", "tokens.cache.write",
}


class UsageJSON:
    """Consume a SQLite blob in bounded chunks; decode only exact allowed leaves.

    Do not replace this with json.load(blob) or SELECT data/json_extract(data,...).
    The message envelope can contain inline chats and tools.
    """

    def __init__(self, blob):
        self.blob = blob
        self.chunk = b""
        self.offset = 0
        self.pushed = None
        self.values = {}

    def byte(self):
        if self.pushed is not None:
            value, self.pushed = self.pushed, None
            return value
        if self.offset == len(self.chunk):
            self.chunk = self.blob.read(4096)
            self.offset = 0
            if not self.chunk:
                return None
        value = self.chunk[self.offset]
        self.offset += 1
        return value

    def next(self):
        value = self.byte()
        while value in (9, 10, 13, 32):
            value = self.byte()
        return value

    def string(self, keep):
        data = bytearray(b'"') if keep else None
        escaped = False
        while True:
            c = self.byte()
            if c is None or c < 32:
                raise ValueError("Invalid usage JSON")
            if keep:
                if len(data) >= 4096:
                    raise ValueError("Usage metadata too long")
                data.append(c)
            if c == 34 and not escaped:
                break
            escaped = c == 92 and not escaped
        return json.loads(data) if keep else None

    def value(self, path="", depth=0):
        if depth > 64:
            raise ValueError("Usage record too deep")
        c, keep = self.next(), path in FIELDS
        if keep and path in self.values:
            raise ValueError("Duplicate usage metadata")
        if c == 34:
            value = self.string(keep)
            if keep:
                self.values[path] = value
        elif c == 123:
            prefix = path + "." if path else ""
            wanted = any(field.startswith(prefix) for field in FIELDS)
            c = self.next()
            if c == 125:
                return
            self.pushed = c
            while True:
                if self.next() != 34:
                    raise ValueError("Invalid usage object")
                key = self.string(wanted)
                if self.next() != 58:
                    raise ValueError("Invalid usage object")
                self.value(prefix + key if wanted else "!", depth + 1)
                c = self.next()
                if c == 125:
                    break
                if c != 44:
                    raise ValueError("Invalid usage object")
        elif c == 91:
            c = self.next()
            if c == 93:
                return
            self.pushed = c
            while True:
                self.value("!", depth + 1)
                c = self.next()
                if c == 93:
                    break
                if c != 44:
                    raise ValueError("Invalid usage array")
        else:
            data = bytearray()
            while c is not None and c not in (9, 10, 13, 32, 44, 93, 125):
                if len(data) >= 64:
                    raise ValueError("Invalid usage scalar")
                data.append(c)
                c = self.byte()
            self.pushed = c
            value = json.loads(data)
            if keep:
                self.values[path] = value

    def read(self):
        self.value()
        if self.next() is not None:
            raise ValueError("Trailing usage data")
        return self.values


def project_name(directory):
    current = Path(directory)
    if not current.is_absolute():
        return ""
    for root in (current, *current.parents):
        if (root / ".git").exists():
            name=root.name
            return name if len(name)<=200 and not any(c in name for c in "/\\:") and not any(unicodedata.category(c)=="Cc" for c in name) else ""
    return ""


def normalized(values, message_id, session_id, directory, parent):
    model = values.get("model.id")
    completed = values.get("time.completed")
    if not isinstance(model, str) or not IDENT.fullmatch(model):
        return None
    if type(completed) is not int or completed <= 0:
        return None
    if not IDENT.fullmatch(session_id) or not message_id or len(message_id) > 512:
        return None
    numbers = {}
    for field in ("input", "output", "reasoning", "cache.read", "cache.write"):
        value = values.get("tokens." + field, 0)
        if type(value) is not int or not 0 <= value <= 10**12:
            return None
        numbers[field] = value
    # OpenCode v2 reports output and reasoning separately. Breadcrumb's output
    # includes reasoning; its input already excludes cache reads and writes.
    if sum(numbers.values()) > 10**12:
        return None
    return {
        "provider": "opencode", "id": message_id, "session": session_id,
        "parent": parent or "", "model": model,
        "time": datetime.datetime.fromtimestamp(completed / 1000, datetime.timezone.utc)
        .isoformat().replace("+00:00", "Z"),
        "project": project_name(directory),
        "input": numbers["input"], "cacheRead": numbers["cache.read"],
        "cacheWrite": numbers["cache.write"], "cacheWrite1h": 0,
        "output": numbers["output"] + numbers["reasoning"],
        "reasoning": numbers["reasoning"],
    }


def export(database, output):
    """Append settled usage, then commit the cursor. Crash retries dedup by ID."""
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    source = sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)
    source.execute("PRAGMA query_only=ON")
    source.execute("PRAGMA cache_size=-1024")
    source.execute("PRAGMA mmap_size=0")
    state_path=Path(str(output)+".state.sqlite")
    state_path.touch(mode=0o600,exist_ok=True)
    state=sqlite3.connect(state_path)
    try:
        state.execute("CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY)")
        state.execute("CREATE TABLE IF NOT EXISTS cursor (id INTEGER PRIMARY KEY, updated INTEGER, identity TEXT, size INTEGER)")
        previous = state.execute("SELECT updated,identity,size FROM cursor WHERE id=1").fetchone()
        stat = database.stat()
        identity = f"{stat.st_dev}:{stat.st_ino}"
        highwater = previous[0] if previous and previous[1] == identity and stat.st_size >= previous[2] else 0
        updated = max(0, highwater - 1000)
        after_id, added = "", 0
        cutoff = int((time.time() - 92 * 86400) * 1000)
        source.execute("BEGIN")
        with os.fdopen(os.open(output,os.O_WRONLY|os.O_APPEND|os.O_CREAT,0o600),"a",encoding="utf-8") as stream:
            while True:
                # Never SELECT message data, session titles, parts, instructions,
                # account/credential tables or blob contents into application memory.
                rows = source.execute("""
                    SELECT m.rowid,m.id,m.session_id,m.time_created,m.time_updated,
                           s.directory,COALESCE(s.fork_session_id,s.parent_id,''),s.time_created
                    FROM session_message m JOIN session_v2 s ON s.id=m.session_id
                    WHERE m.type='assistant' AND m.time_created>=?
                      AND (m.time_updated>? OR (m.time_updated=? AND m.id>?))
                    ORDER BY m.time_updated,m.id LIMIT 500
                """, (cutoff, updated, updated, after_id)).fetchall()
                for rowid, mid, sid, created, stamp, directory, parent, started in rows:
                    updated, after_id = stamp, mid
                    highwater = max(highwater, stamp)
                    digest = hashlib.sha256(mid.encode()).hexdigest()
                    if parent and created < started:
                        continue  # Fork projection copies old messages under new IDs.
                    if state.execute("SELECT 1 FROM seen WHERE id=?", (digest,)).fetchone():
                        continue
                    try:
                        with source.blobopen("session_message", "data", rowid, readonly=True) as blob:
                            event = normalized(UsageJSON(blob).read(), mid, sid, directory, parent)
                    except (ValueError, OverflowError):
                        continue
                    if event is None:
                        continue
                    stream.write(json.dumps(event, ensure_ascii=True, separators=(",", ":")) + "\n")
                    state.execute("INSERT OR IGNORE INTO seen VALUES (?)", (digest,))
                    added += 1
                if len(rows) < 500:
                    break
            stream.flush()
            os.fsync(stream.fileno())
        state.execute("INSERT OR REPLACE INTO cursor VALUES (1,?,?,?)", (highwater, identity, stat.st_size))
        state.commit()
        return added
    finally:
        source.close()
        state.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, default=Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / "opencode/opencode.db")
    parser.add_argument("--output", type=Path, required=True, help="Breadcrumb library/agent-imports/opencode/usage.jsonl")
    parser.add_argument("--initialize", action="store_true", help="Register the provider directory without reading OpenCode")
    parser.add_argument("--watch", action="store_true", help="Explicitly opt in to reading usage every 30 seconds")
    args = parser.parse_args()
    if not hasattr(sqlite3.Connection, "blobopen"):
        parser.error("Python 3.11 or later with SQLite blob streaming is required")
    if args.initialize:
        args.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        args.output.touch(mode=0o600,exist_ok=True)
        print("Provider registered. Enable OpenCode (plugin) in Breadcrumb before running the exporter.")
        return
    try:
        while True:
            print(f"Exported {export(args.database, args.output)} completed usage records.", flush=True)
            if not args.watch:
                break
            time.sleep(30)
    except KeyboardInterrupt:
        pass
    except (sqlite3.Error, OSError):
        parser.exit(1, "OpenCode usage export failed. Check the v2 database and destination. No chat data was exported.\n")


if __name__ == "__main__":
    main()
