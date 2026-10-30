import os
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
load_dotenv()

import requests


class TMDBClient:
    BASE_URL = "https://api.themoviedb.org/3"

    def __init__(self, token: Optional[str] = None):
        self.token = token or os.getenv("TMDB_READ_TOKEN")
        if not self.token:
            raise ValueError(
                "TMDB_READ_TOKEN must be set in environment variables or passed to the constructor."
            )

        self.headers = {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json;charset=utf-8",
        }

    def _get(
        self, endpoint: str, params: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        url = f"{self.BASE_URL}/{endpoint.lstrip('/')}"
        response = requests.get(url, headers=self.headers, params=params, timeout=10)
        response.raise_for_status()
        return response.json()

    def search_movie(self, query: str) -> List[Dict[str, Any]]:
        if not query:
            return []
        data = self._get("search/movie", params={"query": query, "language": "zh-CN"})
        return data.get("results", [])

    def search_tv(self, query: str) -> List[Dict[str, Any]]:
        if not query:
            return []
        data = self._get("search/tv", params={"query": query, "language": "zh-CN"})
        return data.get("results", [])

    def search(
        self, query: str, media_type: Optional[str] = None
    ) -> Dict[str, List[Dict[str, Any]]]:
        result = {"movie": [], "tv": []}
        if not query:
            return result

        if media_type == "movie":
            result["movie"] = self.search_movie(query)
        elif media_type == "tv":
            result["tv"] = self.search_tv(query)
        else:
            result["movie"] = self.search_movie(query)
            result["tv"] = self.search_tv(query)

        return result

    def get_tv_details(self, tmdb_id: int) -> Dict[str, Any]:
        return self._get(f"tv/{tmdb_id}", params={"language": "zh-CN"})

    def get_season_episodes(
        self, tmdb_id: int, season_number: int
    ) -> List[Dict[str, Any]]:
        data = self._get(
            f"tv/{tmdb_id}/season/{season_number}", params={"language": "zh-CN"}
        )
        return data.get("episodes", [])

    def get_popular_movies(self, page: int = 1, pages: int = 0) -> List[Dict[str, Any]]:
        if pages > 0:
            results = []
            for current_page in range(1, pages + 1):
                data = self._get(
                    "movie/popular",
                    params={"language": "zh-CN", "page": current_page},
                )
                results.extend(data.get("results", []))
            return results
        data = self._get("movie/popular", params={"language": "zh-CN", "page": page})
        return data.get("results", [])

    def get_trending_movies(self, time_window: str = "week") -> List[Dict[str, Any]]:
        data = self._get(f"trending/movie/{time_window}", params={"language": "zh-CN"})
        return data.get("results", [])

    def get_trending_tv(self, time_window: str = "week") -> List[Dict[str, Any]]:
        data = self._get(f"trending/tv/{time_window}", params={"language": "zh-CN"})
        return data.get("results", [])

    def get_now_playing_movies(self, page: int = 1, pages: int = 0) -> List[Dict[str, Any]]:
        if pages > 0:
            results = []
            for current_page in range(1, pages + 1):
                data = self._get(
                    "movie/now_playing",
                    params={"language": "zh-CN", "page": current_page},
                )
                results.extend(data.get("results", []))
            return results
        data = self._get(
            "movie/now_playing", params={"language": "zh-CN", "page": page}
        )
        return data.get("results", [])

    def get_upcoming_movies(self, page: int = 1, pages: int = 0) -> List[Dict[str, Any]]:
        if pages > 0:
            results = []
            for current_page in range(1, pages + 1):
                data = self._get(
                    "movie/upcoming",
                    params={"language": "zh-CN", "page": current_page},
                )
                results.extend(data.get("results", []))
            return results
        data = self._get("movie/upcoming", params={"language": "zh-CN", "page": page})
        return data.get("results", [])

    def get_popular_tv(self, page: int = 1, pages: int = 0) -> List[Dict[str, Any]]:
        if pages > 0:
            results = []
            for current_page in range(1, pages + 1):
                data = self._get(
                    "tv/popular", params={"language": "zh-CN", "page": current_page}
                )
                results.extend(data.get("results", []))
            return results
        data = self._get("tv/popular", params={"language": "zh-CN", "page": page})
        return data.get("results", [])

    def get_top_rated_movies(self, page: int = 1, pages: int = 0) -> List[Dict[str, Any]]:
        if pages > 0:
            results = []
            for current_page in range(1, pages + 1):
                data = self._get(
                    "movie/top_rated",
                    params={"language": "zh-CN", "page": current_page},
                )
                results.extend(data.get("results", []))
            return results
        data = self._get(
            "movie/top_rated", params={"language": "zh-CN", "page": page}
        )
        return data.get("results", [])

    def get_top_rated_tv(self, page: int = 1, pages: int = 0) -> List[Dict[str, Any]]:
        if pages > 0:
            results = []
            for current_page in range(1, pages + 1):
                data = self._get(
                    "tv/top_rated", params={"language": "zh-CN", "page": current_page}
                )
                results.extend(data.get("results", []))
            return results
        data = self._get("tv/top_rated", params={"language": "zh-CN", "page": page})
        return data.get("results", [])

    def get_airing_today_tv(self, page: int = 1, pages: int = 0) -> List[Dict[str, Any]]:
        if pages > 0:
            results = []
            for current_page in range(1, pages + 1):
                data = self._get(
                    "tv/airing_today",
                    params={"language": "zh-CN", "page": current_page},
                )
                results.extend(data.get("results", []))
            return results
        data = self._get(
            "tv/airing_today", params={"language": "zh-CN", "page": page}
        )
        return data.get("results", [])

    def get_on_the_air_tv(self, page: int = 1, pages: int = 0) -> List[Dict[str, Any]]:
        if pages > 0:
            results = []
            for current_page in range(1, pages + 1):
                data = self._get(
                    "tv/on_the_air",
                    params={"language": "zh-CN", "page": current_page},
                )
                results.extend(data.get("results", []))
            return results
        data = self._get("tv/on_the_air", params={"language": "zh-CN", "page": page})
        return data.get("results", [])

    def discover_movies(
        self,
        sort_by: str = "vote_average.desc",
        vote_count_gte: int = 1000,
        year_from: Optional[str] = None,
        year_to: Optional[str] = None,
        genre_id: Optional[int] = None,
        page: int = 1,
        pages: int = 0,
    ) -> List[Dict[str, Any]]:
        params = {
            "language": "zh-CN",
            "sort_by": sort_by,
            "vote_count.gte": vote_count_gte,
            "page": page,
        }
        if year_from:
            params["primary_release_date.gte"] = f"{year_from}-01-01"
        if year_to:
            params["primary_release_date.lte"] = f"{year_to}-12-31"
        if genre_id:
            params["with_genres"] = genre_id

        if pages > 0:
            results = []
            for current_page in range(1, pages + 1):
                params["page"] = current_page
                data = self._get("discover/movie", params=params)
                results.extend(data.get("results", []))
            return results
        data = self._get("discover/movie", params=params)
        return data.get("results", [])

    def discover_tv(
        self,
        sort_by: str = "vote_average.desc",
        vote_count_gte: int = 100,
        genre_id: Optional[int] = None,
        page: int = 1,
        pages: int = 0,
    ) -> List[Dict[str, Any]]:
        params = {
            "language": "zh-CN",
            "sort_by": sort_by,
            "vote_count.gte": vote_count_gte,
            "page": page,
        }
        if genre_id:
            params["with_genres"] = genre_id

        if pages > 0:
            results = []
            for current_page in range(1, pages + 1):
                params["page"] = current_page
                data = self._get("discover/tv", params=params)
                results.extend(data.get("results", []))
            return results
        data = self._get("discover/tv", params=params)
        return data.get("results", [])

    def get_movie_genres(self) -> Dict[int, str]:
        data = self._get("genre/movie/list", params={"language": "zh-CN"})
        return {genre["id"]: genre["name"] for genre in data.get("genres", [])}

    def get_tv_genres(self) -> Dict[int, str]:
        data = self._get("genre/tv/list", params={"language": "zh-CN"})
        return {genre["id"]: genre["name"] for genre in data.get("genres", [])}
