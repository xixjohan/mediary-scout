import os
import sys
import tempfile
import unittest


def load_database_module(test_case: unittest.TestCase):
    try:
        scripts_dir = os.path.abspath(
            os.path.join(os.path.dirname(__file__), "..", "scripts")
        )
        if scripts_dir not in sys.path:
            sys.path.insert(0, scripts_dir)
        import database  # type: ignore
    except ImportError as exc:  # pragma: no cover - exercised in red phase
        test_case.fail(f"database module is not implemented yet: {exc}")
    return database


class DatabaseCoreTests(unittest.TestCase):
    def test_database_context_manager_closes_connection_on_exit(self):
        database = load_database_module(self)

        with tempfile.TemporaryDirectory() as temp_dir:
            db_path = os.path.join(temp_dir, "tracking.db")
            with database.Database(db_path=db_path) as db:
                row = db.conn.execute("SELECT 1 AS value").fetchone()

            self.assertIsNone(db.conn)

        self.assertEqual(row["value"], 1)

    def test_init_creates_shows_table(self):
        database = load_database_module(self)

        with tempfile.TemporaryDirectory() as temp_dir:
            db_path = os.path.join(temp_dir, "tracking.db")
            with database.Database(db_path=db_path) as db:
                row = db.conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name='shows'"
                ).fetchone()

        self.assertIsNotNone(row)
        self.assertEqual(row["name"], "shows")

    def test_add_show_persists_row_with_defaults(self):
        database = load_database_module(self)

        with tempfile.TemporaryDirectory() as temp_dir:
            db_path = os.path.join(temp_dir, "tracking.db")
            with database.Database(db_path=db_path) as db:
                show_id = db.add_show(tmdb_id=1001, name="除恶", total_episodes=16)
                row = db.conn.execute(
                    "SELECT * FROM shows WHERE id=?",
                    (show_id,),
                ).fetchone()

        self.assertGreater(show_id, 0)
        self.assertEqual(row["tmdb_id"], 1001)
        self.assertEqual(row["name"], "除恶")
        self.assertEqual(row["season"], 1)
        self.assertEqual(row["quality_pref"], "any")
        self.assertEqual(row["status"], "active")
        self.assertEqual(row["episodes_status"], "[]")
        self.assertEqual(row["total_episodes"], 16)

    def test_add_show_rejects_season_less_than_1(self):
        database = load_database_module(self)

        with tempfile.TemporaryDirectory() as temp_dir:
            db_path = os.path.join(temp_dir, "tracking.db")
            with database.Database(db_path=db_path) as db:
                with self.assertRaises(ValueError) as ctx:
                    db.add_show(tmdb_id=1002, name="匹兹堡", season=0)

        self.assertIn("season", str(ctx.exception).lower())

    def test_get_episodes_returns_empty_list_for_new_show(self):
        database = load_database_module(self)

        with tempfile.TemporaryDirectory() as temp_dir:
            db_path = os.path.join(temp_dir, "tracking.db")
            with database.Database(db_path=db_path) as db:
                show_id = db.add_show(tmdb_id=2002, name="太平年")
                episodes = db._get_episodes(show_id)

        self.assertEqual(episodes, [])

    def test_update_save_dir_persists_directory_id(self):
        database = load_database_module(self)

        with tempfile.TemporaryDirectory() as temp_dir:
            db_path = os.path.join(temp_dir, "tracking.db")
            with database.Database(db_path=db_path) as db:
                show_id = db.add_show(tmdb_id=3003, name="地狱担保人")

                db.update_save_dir(show_id=show_id, save_dir_id="season-dir-cid")
                row = db.conn.execute(
                    "SELECT save_dir_id FROM shows WHERE id=?",
                    (show_id,),
                ).fetchone()

        self.assertEqual(row["save_dir_id"], "season-dir-cid")

    def test_mark_obtained_updates_selected_episode_flags(self):
        database = load_database_module(self)

        with tempfile.TemporaryDirectory() as temp_dir:
            db_path = os.path.join(temp_dir, "tracking.db")
            with database.Database(db_path=db_path) as db:
                show_id = db.add_show(tmdb_id=4004, name="风起陇西")
                db.conn.execute(
                    "UPDATE shows SET episodes_status=? WHERE id=?",
                    (
                        '[{"episode":"S01E01","name":"第一集","obtained":false},'
                        '{"episode":"S01E02","name":"第二集","obtained":false}]',
                        show_id,
                    ),
                )
                db.conn.commit()

                db.mark_obtained(show_id=show_id, episode_codes=["S01E02"])
                episodes = db._get_episodes(show_id)

        self.assertEqual(len(episodes), 2)
        self.assertFalse(episodes[0].obtained)
        self.assertTrue(episodes[1].obtained)

    def test_delete_show_removes_row(self):
        database = load_database_module(self)

        with tempfile.TemporaryDirectory() as temp_dir:
            db_path = os.path.join(temp_dir, "tracking.db")
            with database.Database(db_path=db_path) as db:
                show_id = db.add_show(tmdb_id=5005, name="除恶")

                deleted = db.delete_show(show_id=show_id)
                row = db.conn.execute(
                    "SELECT id FROM shows WHERE id=?",
                    (show_id,),
                ).fetchone()

        self.assertTrue(deleted)
        self.assertIsNone(row)


class FakeTMDBClient:
    def __init__(self):
        self.details = {}
        self.seasons = {}

    def get_tv_details(self, tmdb_id: int):
        return self.details[tmdb_id]

    def get_season_episodes(self, tmdb_id: int, season_number: int):
        return self.seasons[(tmdb_id, season_number)]


class DatabaseSyncTests(unittest.TestCase):
    def test_sync_all_builds_missing_episode_list_for_tracked_season(self):
        database = load_database_module(self)
        tmdb = FakeTMDBClient()
        tmdb.details[9001] = {
            "last_episode_to_air": {"season_number": 1, "episode_number": 3},
            "number_of_episodes": 10,
            "in_production": True,
        }
        tmdb.seasons[(9001, 1)] = [
            {"episode_number": 1, "name": "第一集"},
            {"episode_number": 2, "name": "第二集"},
            {"episode_number": 3, "name": "第三集"},
            {"episode_number": 4, "name": "第四集"},
        ]

        with tempfile.TemporaryDirectory() as temp_dir:
            db_path = os.path.join(temp_dir, "tracking.db")
            with database.Database(db_path=db_path) as db:
                show_id = db.add_show(
                    tmdb_id=9001,
                    name="除恶",
                    season=1,
                    year=2026,
                    category="tv",
                    quality_pref="4K",
                    save_dir_id="season-dir-cid",
                    total_episodes=10,
                )

                shows = db.sync_all(tmdb_client=tmdb)
                episodes = db._get_episodes(show_id)

        self.assertEqual(len(shows), 1)
        show = shows[0]
        self.assertEqual(show.show_id, show_id)
        self.assertEqual(show.latest_season, 1)
        self.assertEqual(show.latest_episode, 3)
        self.assertEqual(show.total_episodes, 10)
        self.assertEqual([episode.episode for episode in episodes], ["S01E01", "S01E02", "S01E03"])
        self.assertEqual([episode.episode for episode in show.missing], ["S01E01", "S01E02", "S01E03"])

    def test_sync_all_marks_completed_show_out_of_active_queue(self):
        database = load_database_module(self)
        tmdb = FakeTMDBClient()
        tmdb.details[9002] = {
            "last_episode_to_air": {"season_number": 1, "episode_number": 2},
            "number_of_episodes": 2,
            "in_production": False,
        }
        tmdb.seasons[(9002, 1)] = [
            {"episode_number": 1, "name": "第一集"},
            {"episode_number": 2, "name": "第二集"},
        ]

        with tempfile.TemporaryDirectory() as temp_dir:
            db_path = os.path.join(temp_dir, "tracking.db")
            with database.Database(db_path=db_path) as db:
                show_id = db.add_show(tmdb_id=9002, name="太平年", season=1, total_episodes=2)
                db.conn.execute(
                    "UPDATE shows SET episodes_status=? WHERE id=?",
                    (
                        '[{"episode":"S01E01","name":"第一集","obtained":true},'
                        '{"episode":"S01E02","name":"第二集","obtained":true}]',
                        show_id,
                    ),
                )
                db.conn.commit()

                shows = db.sync_all(tmdb_client=tmdb)
                row = db.conn.execute(
                    "SELECT status FROM shows WHERE id=?",
                    (show_id,),
                ).fetchone()

        self.assertEqual(shows, [])
        self.assertEqual(row["status"], "completed")

    def test_sync_all_rejects_invalid_stored_season_less_than_1(self):
        database = load_database_module(self)
        tmdb = FakeTMDBClient()
        tmdb.details[9003] = {
            "last_episode_to_air": {"season_number": 1, "episode_number": 1},
            "number_of_episodes": 1,
            "in_production": False,
            "seasons": [{"season_number": 1}],
        }
        tmdb.seasons[(9003, 1)] = [{"episode_number": 1, "name": "第一集"}]

        with tempfile.TemporaryDirectory() as temp_dir:
            db_path = os.path.join(temp_dir, "tracking.db")
            with database.Database(db_path=db_path) as db:
                show_id = db.add_show(tmdb_id=9003, name="匹兹堡", season=1, total_episodes=1)
                db.conn.execute("UPDATE shows SET season=0 WHERE id=?", (show_id,))
                db.conn.commit()

                with self.assertRaises(ValueError) as ctx:
                    db.sync_all(tmdb_client=tmdb)

        self.assertIn("season", str(ctx.exception).lower())
