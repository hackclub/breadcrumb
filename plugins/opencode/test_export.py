import gc
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import time
import tracemalloc
import unittest

spec = importlib.util.spec_from_file_location("usage_export", Path(__file__).with_name("export.py"))
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.database = self.root / "opencode.db"
        self.output = self.root / "imports/opencode/usage.jsonl"
        self.now = int(time.time() * 1000)
        self.db = sqlite3.connect(self.database)
        self.db.executescript("""
          CREATE TABLE session_v2(id TEXT PRIMARY KEY,directory TEXT,parent_id TEXT,fork_session_id TEXT,time_created INTEGER);
          CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
        """)
        self.db.execute("INSERT INTO session_v2 VALUES ('parent',?,NULL,NULL,?)", (str(self.root), self.now - 10000))
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def message(self, mid, session="parent", created=None, completed=True, padding="PROMPT_SENTINEL"):
        data = {"model": {"id": "deepseek-v4.1-flash-free", "providerID": "opencode"},
                "time": {"completed": self.now if completed else None},
                "tokens": {"input": 100, "output": 20, "reasoning": 5, "cache": {"read": 50, "write": 10}},
                "content": [{"text": padding, "response": "RESPONSE_SENTINEL", "tool": {"output": "TOOL_SENTINEL"}}]}
        self.db.execute("INSERT OR REPLACE INTO session_message VALUES (?,?,?,?,?,?)", (mid, session, "assistant", created or self.now, self.now, json.dumps(data)))
        self.db.commit()

    def test_usage_only_dedup_incremental_and_forks(self):
        self.message("message-one")
        self.message("unfinished", completed=False)
        self.assertEqual(plugin.export(self.database, self.output), 1)
        self.assertEqual(plugin.export(self.database, self.output), 0)
        self.message("message-two")
        self.db.execute("INSERT INTO session_v2 VALUES ('child',?,NULL,'parent',?)", (str(self.root), self.now + 1000))
        self.db.commit()
        self.message("copied-with-new-id", session="child", created=self.now)
        self.message("child-own", session="child", created=self.now + 2000)
        self.assertEqual(plugin.export(self.database, self.output), 2)
        text = self.output.read_text()
        self.assertNotIn("SENTINEL", text)
        self.assertNotIn(str(self.root), text)
        self.assertNotIn(b"SENTINEL",Path(str(self.output)+".state.sqlite").read_bytes())
        rows = [json.loads(line) for line in text.splitlines()]
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[0]["input"], 100)
        self.assertEqual(rows[0]["output"], 25)
        self.assertEqual(rows[0]["reasoning"], 5)
        self.assertEqual(rows[0]["project"], "")
        self.assertNotIn("cost", rows[0])
        self.message("unfinished", completed=True)
        self.assertEqual(plugin.export(self.database, self.output), 1)
        self.assertEqual(plugin.export(self.database, self.output), 0)

    def test_streaming_does_not_retain_large_content(self):
        self.message("large", padding="x" * (5 << 20))
        gc.collect()
        tracemalloc.start()
        plugin.export(self.database, self.output)
        _, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        self.assertLess(peak, 1 << 20)
        self.assertLess(self.output.stat().st_size, 1024)

    def test_project_uses_git_root_not_home_name(self):
        nested = self.root / "repo/src"
        nested.mkdir(parents=True)
        (self.root / "repo/.git").mkdir()
        self.assertEqual(plugin.project_name(str(nested)), "repo")
        self.assertEqual(plugin.project_name(str(self.root)), "")

    def test_unknown_content_and_invalid_usage(self):
        values = plugin.UsageJSON(io.BytesIO(b'{"content":{"text":"SECRET"},"tokens":{"input":1},"model":{"id":"model"},"time":{"completed":1}}')).read()
        self.assertNotIn("content", values)
        for value in (-1, True, "100", 1.5):
            self.assertIsNone(plugin.normalized({"model.id": "model", "time.completed": self.now, "tokens.input": value}, "m", "s", str(self.root), ""))
        with self.assertRaises(ValueError):
            plugin.UsageJSON(io.BytesIO(b'{"tokens":{"input":1,"input":2}}')).read()
        with self.assertRaises(ValueError):
            plugin.UsageJSON(io.BytesIO(b'{"tokens":{"input":"PROMPT_SENTINEL"}}')).read()


if __name__ == "__main__":
    unittest.main()
