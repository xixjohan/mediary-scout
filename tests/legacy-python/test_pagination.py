"""TDD tests for pagination support in pan115_client.

115 API has a page size limit (default 32, max 1150).
These tests verify that list_files and list_video_files 
automatically fetch all pages without the caller needing
to know about pagination.
"""
import os
import sys
import unittest
from unittest.mock import patch


def load_pan115_module(test_case: unittest.TestCase):
    scripts_dir = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "scripts")
    )
    if scripts_dir not in sys.path:
        sys.path.insert(0, scripts_dir)
    import pan115_client  # type: ignore
    return pan115_client


class FakeP115ClientPaginated:
    """Fake 115 client that simulates pagination behavior."""
    
    PAGE_SIZE = 32  # Default 115 API page size
    
    def __init__(self, cookies, check_for_relogin):
        self.cookies = cookies
        self.check_for_relogin = check_for_relogin
        self.headers = {}
        # Store total items per folder
        self.folder_sizes = {}
    
    def set_folder_size(self, cid: str, total_items: int):
        """Configure how many items are in a folder."""
        self.folder_sizes[cid] = total_items
    
    def fs_files(self, payload):
        """Return paginated results based on offset and limit."""
        if isinstance(payload, str):
            cid = payload
            offset = 0
            limit = self.PAGE_SIZE
        else:
            cid = payload.get("cid", "0")
            offset = payload.get("offset", 0)
            limit = payload.get("limit", self.PAGE_SIZE)
        
        total = self.folder_sizes.get(cid, 0)
        
        # Generate fake items for this page
        items = []
        for i in range(offset, min(offset + limit, total)):
            items.append({
                "fid": f"file-{i}",
                "fc": "1",  # File, not folder
                "n": f"episode{i+1:02d}.mkv",
                "s": str(1000 + i),
            })
        
        return {
            "state": True,
            "count": total,  # Total count (may be inaccurate in real API)
            "data": items,
        }


class PaginationTests(unittest.TestCase):
    """RED phase tests - these should fail until pagination is implemented."""

    def test_get_all_items_fetches_all_pages_when_more_than_32_items(self):
        """RED: _get_all_items should fetch all items, not just first page."""
        pan115_client = load_pan115_module(self)
        
        fake_client = FakeP115ClientPaginated("test", True)
        fake_client.set_folder_size("test-folder", 50)  # More than 32
        
        with patch.dict(os.environ, {"PAN115_COOKIE": "UID=test;CID=test;SEID=test;KID=test"}, clear=True):
            with patch.object(pan115_client, "P115Client", lambda **kwargs: fake_client):
                client = pan115_client.Pan115Client()
        
        client._min_interval = 0
        
        # This should return all 50 items, not just 32
        items = client._get_all_items("test-folder")
        self.assertEqual(len(items), 50, 
            f"Expected 50 items but got {len(items)}. "
            f"Pagination not working - only first page returned?")
    
    def test_list_files_fetches_all_pages(self):
        """RED: list_files should return all files across all pages."""
        pan115_client = load_pan115_module(self)
        
        fake_client = FakeP115ClientPaginated("test", True)
        fake_client.set_folder_size("root", 40)  # 40 episodes like 白日提灯
        
        with patch.dict(os.environ, {"PAN115_COOKIE": "UID=test;CID=test;SEID=test;KID=test"}, clear=True):
            with patch.object(pan115_client, "P115Client", lambda **kwargs: fake_client):
                client = pan115_client.Pan115Client()
        
        client._min_interval = 0
        
        files = client.list_files(cid="root", depth=1)
        self.assertEqual(len(files), 40,
            f"Expected 40 files but got {len(files)}. "
            "Pagination not working - episodes in later pages missing?")
    
    def test_list_video_files_fetches_all_pages(self):
        """RED: list_video_files should return all videos across all pages."""
        pan115_client = load_pan115_module(self)
        
        fake_client = FakeP115ClientPaginated("test", True)
        fake_client.set_folder_size("root", 40)
        
        with patch.dict(os.environ, {"PAN115_COOKIE": "UID=test;CID=test;SEID=test;KID=test"}, clear=True):
            with patch.object(pan115_client, "P115Client", lambda **kwargs: fake_client):
                client = pan115_client.Pan115Client()
        
        client._min_interval = 0
        
        videos = client.list_video_files(cid="root", depth=1)
        self.assertEqual(len(videos), 40,
            f"Expected 40 videos but got {len(videos)}. "
            "Pagination not working - videos in later pages missing?")
    
    def test_pagination_handles_exact_page_boundary(self):
        """Test edge case: exactly 32 items (one full page)."""
        pan115_client = load_pan115_module(self)
        
        fake_client = FakeP115ClientPaginated("test", True)
        fake_client.set_folder_size("root", 32)  # Exactly one page
        
        with patch.dict(os.environ, {"PAN115_COOKIE": "UID=test;CID=test;SEID=test;KID=test"}, clear=True):
            with patch.object(pan115_client, "P115Client", lambda **kwargs: fake_client):
                client = pan115_client.Pan115Client()
        
        client._min_interval = 0
        
        items = client._get_all_items("root")
        self.assertEqual(len(items), 32)
    
    def test_pagination_handles_empty_folder(self):
        """Test edge case: empty folder."""
        pan115_client = load_pan115_module(self)
        
        fake_client = FakeP115ClientPaginated("test", True)
        fake_client.set_folder_size("empty", 0)
        
        with patch.dict(os.environ, {"PAN115_COOKIE": "UID=test;CID=test;SEID=test;KID=test"}, clear=True):
            with patch.object(pan115_client, "P115Client", lambda **kwargs: fake_client):
                client = pan115_client.Pan115Client()
        
        client._min_interval = 0
        
        items = client._get_all_items("empty")
        self.assertEqual(len(items), 0)


if __name__ == "__main__":
    unittest.main()
