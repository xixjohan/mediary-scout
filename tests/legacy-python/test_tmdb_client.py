import os
import sys
import unittest
from unittest.mock import patch


def load_tmdb_module(test_case: unittest.TestCase):
    try:
        scripts_dir = os.path.abspath(
            os.path.join(os.path.dirname(__file__), "..", "scripts")
        )
        if scripts_dir not in sys.path:
            sys.path.insert(0, scripts_dir)
        import tmdb_client  # type: ignore
    except ImportError as exc:  # pragma: no cover - exercised in red phase
        test_case.fail(f"tmdb_client module is not implemented yet: {exc}")
    return tmdb_client


class TMDBClientConfigTests(unittest.TestCase):
    def test_explicit_token_takes_priority(self):
        tmdb_client = load_tmdb_module(self)

        with patch.dict(os.environ, {"TMDB_READ_TOKEN": "env-token"}, clear=False):
            client = tmdb_client.TMDBClient(token="explicit-token")

        self.assertEqual(client.token, "explicit-token")
        self.assertEqual(client.headers["Authorization"], "Bearer explicit-token")

    def test_env_token_is_used_when_constructor_token_missing(self):
        tmdb_client = load_tmdb_module(self)

        with patch.dict(os.environ, {"TMDB_READ_TOKEN": "env-token"}, clear=True):
            client = tmdb_client.TMDBClient()

        self.assertEqual(client.token, "env-token")
        self.assertEqual(client.headers["Authorization"], "Bearer env-token")

    def test_missing_token_raises_clear_error(self):
        tmdb_client = load_tmdb_module(self)

        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(ValueError) as ctx:
                tmdb_client.TMDBClient()

        self.assertIn("TMDB_READ_TOKEN", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
