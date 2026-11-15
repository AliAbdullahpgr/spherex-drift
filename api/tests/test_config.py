"""Check deployment configuration in isolation from the test runner's environment."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class CacheDirectoryTests(unittest.TestCase):
    def cache_dir(self, **overrides):
        env = os.environ.copy()
        for name in ("VERCEL", "SPHEREX_CACHE_DIR"):
            env.pop(name, None)
        env.update(overrides)
        result = subprocess.run(
            [sys.executable, "-c",
             "import json; from app.config import CACHE_DIR; print(json.dumps(str(CACHE_DIR)))"],
            cwd=Path(__file__).resolve().parents[1], env=env,
            capture_output=True, text=True, check=True,
        )
        return Path(json.loads(result.stdout))

    def test_local_cache_stays_in_api_directory(self):
        self.assertEqual(self.cache_dir(), Path(__file__).resolve().parents[1] / "cache")

    def test_vercel_cache_uses_writable_temporary_storage(self):
        self.assertEqual(self.cache_dir(VERCEL="1"),
                         Path(tempfile.gettempdir()) / "spherex-drift-cache")

    def test_explicit_cache_directory_takes_precedence(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(self.cache_dir(VERCEL="1", SPHEREX_CACHE_DIR=directory),
                             Path(directory))
