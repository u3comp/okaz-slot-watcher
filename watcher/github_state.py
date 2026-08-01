from __future__ import annotations

import json
from dataclasses import dataclass
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

from .model import STATE_ISSUE_TITLE
from .state import decode_issue_body, default_state, encode_issue_body


class GitHubStateError(RuntimeError):
    pass


@dataclass(frozen=True)
class LoadedState:
    state: dict
    issue_number: int | None
    recovered_from_corruption: bool = False


class GitHubIssueStore:
    def __init__(self, repository: str, token: str, api_url: str = "https://api.github.com") -> None:
        if "/" not in repository:
            raise ValueError("repository must be owner/name")
        self.repository = repository
        self.token = token
        self.api_url = api_url.rstrip("/")

    def _request(self, method: str, path: str, payload: dict | None = None):
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        request = Request(
            f"{self.api_url}{path}",
            data=data,
            method=method,
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {self.token}",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "okaz-slot-watcher",
                "Content-Type": "application/json",
            },
        )
        try:
            with urlopen(request, timeout=30) as response:
                raw = response.read()
        except HTTPError as exc:
            raise GitHubStateError(f"GitHub API returned HTTP {exc.code}") from None
        except (URLError, TimeoutError):
            raise GitHubStateError("GitHub API request failed") from None
        return json.loads(raw.decode("utf-8")) if raw else None

    def load(self) -> LoadedState:
        repo = quote(self.repository, safe="/")
        issues = self._request("GET", f"/repos/{repo}/issues?state=all&per_page=100")
        matches = [
            issue
            for issue in issues
            if issue.get("title") == STATE_ISSUE_TITLE
            and issue.get("user", {}).get("login") == "github-actions[bot]"
            and "pull_request" not in issue
        ]
        if not matches:
            return LoadedState(default_state(), None)
        issue = sorted(matches, key=lambda item: int(item["number"]))[0]
        try:
            state = decode_issue_body(issue.get("body"))
            return LoadedState(state, int(issue["number"]))
        except (ValueError, TypeError, json.JSONDecodeError):
            return LoadedState(default_state(), int(issue["number"]), True)

    def save(self, state: dict, issue_number: int | None) -> int:
        repo = quote(self.repository, safe="/")
        payload = {"title": STATE_ISSUE_TITLE, "body": encode_issue_body(state)}
        if issue_number is None:
            issue = self._request("POST", f"/repos/{repo}/issues", payload)
        else:
            issue = self._request("PATCH", f"/repos/{repo}/issues/{issue_number}", payload)
        return int(issue["number"])
