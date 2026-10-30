import json
import sqlite3
from dataclasses import dataclass
from typing import List, Optional


@dataclass
class Episode:
    episode: str
    name: str
    obtained: bool


@dataclass
class Show:
    show_id: int
    tmdb_id: int
    name: str
    season: int
    year: Optional[int]
    category: Optional[str]
    quality_pref: str
    save_dir_id: Optional[str]
    latest_season: int
    latest_episode: int
    total_episodes: int
    episodes: List[Episode]
    missing: List[Episode]


class Database:
    def __init__(self, db_path: str = "tracking.db"):
        self.conn = sqlite3.connect(db_path)
        self.conn.row_factory = sqlite3.Row
        self._init_db()

    def close(self):
        if getattr(self, "conn", None) is not None:
            self.conn.close()
            self.conn = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        self.close()

    def _init_db(self):
        self.conn.execute(
            """
            CREATE TABLE IF NOT EXISTS shows (
                id INTEGER PRIMARY KEY,
                tmdb_id INTEGER,
                season INTEGER DEFAULT 1,
                name TEXT,
                year INTEGER,
                category TEXT,
                quality_pref TEXT DEFAULT 'any',
                save_dir_id TEXT,
                status TEXT DEFAULT 'active',
                episodes_status TEXT DEFAULT '[]',
                total_episodes INTEGER DEFAULT 0,
                UNIQUE(tmdb_id, season)
            )
            """
        )
        self.conn.commit()

    def _validate_season(self, season: int):
        if season < 1:
            raise ValueError("season must be >= 1 for single-season tracking.")

    def add_show(
        self,
        tmdb_id: int,
        name: str,
        season: int = 1,
        year: Optional[int] = None,
        category: Optional[str] = None,
        quality_pref: str = "any",
        save_dir_id: Optional[str] = None,
        total_episodes: int = 0,
    ) -> int:
        self._validate_season(season)
        cursor = self.conn.execute(
            """
            INSERT OR REPLACE INTO shows
                (tmdb_id, season, name, year, category, quality_pref, save_dir_id, total_episodes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                tmdb_id,
                season,
                name,
                year,
                category,
                quality_pref,
                save_dir_id,
                total_episodes,
            ),
        )
        self.conn.commit()
        return cursor.lastrowid or 0

    def _get_episodes(self, show_id: int) -> List[Episode]:
        row = self.conn.execute(
            "SELECT episodes_status FROM shows WHERE id=?",
            (show_id,),
        ).fetchone()
        if not row or not row["episodes_status"]:
            return []
        data = json.loads(row["episodes_status"])
        return [Episode(**episode) for episode in data]

    def update_save_dir(self, show_id: int, save_dir_id: str):
        self.conn.execute(
            "UPDATE shows SET save_dir_id=? WHERE id=?",
            (save_dir_id, show_id),
        )
        self.conn.commit()

    def mark_obtained(self, show_id: int, episode_codes: List[str]):
        episodes = self._get_episodes(show_id)
        for episode in episodes:
            if episode.episode in episode_codes:
                episode.obtained = True

        self.conn.execute(
            "UPDATE shows SET episodes_status=? WHERE id=?",
            (
                json.dumps(
                    [
                        {
                            "episode": episode.episode,
                            "name": episode.name,
                            "obtained": episode.obtained,
                        }
                        for episode in episodes
                    ]
                ),
                show_id,
            ),
        )
        self.conn.commit()

    def delete_show(self, show_id: int) -> bool:
        self.conn.execute(
            "DELETE FROM shows WHERE id=?",
            (show_id,),
        )
        self.conn.commit()
        return True

    def sync_all(self, tmdb_client) -> List[Show]:
        result = []
        shows = self.conn.execute(
            "SELECT * FROM shows WHERE status='active'"
        ).fetchall()

        for show in shows:
            details = tmdb_client.get_tv_details(show["tmdb_id"])
            episodes = self._get_episodes(show["id"])

            last_episode = details.get("last_episode_to_air", {})
            latest_season = last_episode.get("season_number", 0) or 0
            latest_episode = last_episode.get("episode_number", 0) or 0
            total_episodes = details.get("number_of_episodes", 0) or 0
            track_season = show["season"]
            self._validate_season(track_season)

            season_number = track_season
            season_episodes = tmdb_client.get_season_episodes(
                show["tmdb_id"], season_number
            )
            for episode in season_episodes:
                episode_number = episode["episode_number"]
                if episode_number > latest_episode:
                    continue
                code = f"S{season_number:02d}E{episode_number:02d}"
                if not any(item.episode == code for item in episodes):
                    episodes.append(Episode(code, episode.get("name", ""), False))

            self.conn.execute(
                "UPDATE shows SET episodes_status=? WHERE id=?",
                (
                    json.dumps(
                        [
                            {
                                "episode": episode.episode,
                                "name": episode.name,
                                "obtained": episode.obtained,
                            }
                            for episode in episodes
                        ]
                    ),
                    show["id"],
                ),
            )

            missing = [episode for episode in episodes if not episode.obtained]
            if missing:
                result.append(
                    Show(
                        show_id=show["id"],
                        tmdb_id=show["tmdb_id"],
                        name=show["name"],
                        season=show["season"],
                        year=show["year"],
                        category=show["category"],
                        quality_pref=show["quality_pref"] or "any",
                        save_dir_id=show["save_dir_id"],
                        latest_season=latest_season,
                        latest_episode=latest_episode,
                        total_episodes=total_episodes,
                        episodes=episodes,
                        missing=missing,
                    )
                )

            is_done = (
                latest_episode == total_episodes
                and len(episodes) == total_episodes
                and not missing
                and not details.get("in_production")
            )
            if is_done:
                self.conn.execute(
                    "UPDATE shows SET status='completed' WHERE id=?",
                    (show["id"],),
                )

        self.conn.commit()
        return result
