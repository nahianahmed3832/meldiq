"""Meldiq's native Bot HTTP API. Python 3.10+, standard library only."""
import json
import posixpath
import urllib.error
import urllib.parse
import urllib.request


class MeldiqBotError(Exception):
    def __init__(self, status, code, message, retry_after_seconds=None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.retry_after_seconds = retry_after_seconds


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, new_url):
        return None


class MeldiqBot:
    def __init__(self, api_origin, token, timeout=30, max_response_bytes=16 * 1024 * 1024):
        parsed = urllib.parse.urlsplit(api_origin)
        if not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
            raise ValueError("Configure an API origin without credentials, path or query")
        if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1", "::1")):
            raise ValueError("Use HTTPS, or HTTP on loopback for local development")
        if not isinstance(token, str) or not token.startswith("mqb_") or len(token) > 200 or any(c.isspace() for c in token):
            raise ValueError("A Meldiq bot token is required")
        if not 0.1 <= timeout <= 120 or not 1024 <= max_response_bytes <= 64 * 1024 * 1024:
            raise ValueError("Invalid client timeout or response budget")
        self.api_origin = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))
        self._token = token
        self.timeout = timeout
        self.max_response_bytes = max_response_bytes
        self._opener = urllib.request.build_opener(_NoRedirect())

    def request(self, method, path, body=None, raw=None):
        url = urllib.parse.urljoin(self.api_origin + "/", path)
        parsed = urllib.parse.urlsplit(url)
        decoded_path = urllib.parse.unquote(parsed.path)
        if urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "", "", "")) != self.api_origin or not posixpath.normpath(decoded_path).startswith("/v2/bot/") or parsed.fragment:
            raise ValueError("Only native /v2/bot/ paths on the configured origin are allowed")
        if method not in ("GET", "POST", "PUT", "PATCH", "DELETE") or (body is not None and raw is not None):
            raise ValueError("Invalid bot request")
        headers = {"Authorization": "Bot " + self._token, "Accept": "application/json"}
        data = raw if raw is not None else json.dumps(body).encode() if body is not None else None
        if data is not None:
            headers["Content-Type"] = "application/octet-stream" if raw is not None else "application/json"
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            response = self._opener.open(request, timeout=self.timeout)
        except urllib.error.HTTPError as error:
            response = error
        except (urllib.error.URLError, TimeoutError, OSError):
            raise MeldiqBotError(0, "network_error", "The bot API request failed or timed out") from None
        with response:
            value = response.read(self.max_response_bytes + 1)
            if len(value) > self.max_response_bytes:
                raise MeldiqBotError(response.status, "response_too_large", "Request a smaller page; the client response budget was exceeded")
            try:
                result = json.loads(value)
            except (ValueError, UnicodeError):
                raise MeldiqBotError(response.status, "invalid_response", "The bot API response was not valid JSON") from None
            if not 200 <= response.status < 300:
                envelope = result.get("error", {}) if isinstance(result, dict) else {}
                retry = response.headers.get("Retry-After")
                retry = min(int(retry), 86400) if retry and retry.isdigit() else None
                raise MeldiqBotError(response.status, envelope.get("code", "request_failed"), envelope.get("message", "The bot API refused the request"), retry)
            return result

    def me(self):
        return self.request("GET", "/v2/bot/me")

    def communities(self):
        return self.request("GET", "/v2/bot/communities")

    def events(self, cursor=None, limit=50):
        return self.request("GET", "/v2/bot/events?" + urllib.parse.urlencode({"limit": limit, **({"cursor": cursor} if cursor else {})}))

    def _message_body(self, content, message_id, reply_to, embeds, buttons, components, components_ttl_seconds):
        optional = {"messageId": message_id, "replyTo": reply_to, "embeds": embeds, "buttons": buttons, "components": components, "componentsTtlSeconds": components_ttl_seconds}
        return {"content": content, **{key: value for key, value in optional.items() if value is not None}}

    def send(self, channel_id, content, message_id=None, *, reply_to=None, embeds=None, buttons=None, components=None, components_ttl_seconds=None):
        return self.request("POST", "/v2/bot/channels/" + urllib.parse.quote(channel_id, safe="") + "/messages", self._message_body(content, message_id, reply_to, embeds, buttons, components, components_ttl_seconds))

    def set_commands(self, commands):
        return self.request("PUT", "/v2/bot/commands", {"commands": commands})

    def send_direct(self, user_id, content, message_id=None, *, reply_to=None, embeds=None, buttons=None, components=None, components_ttl_seconds=None):
        return self.request("POST", "/v2/bot/users/" + urllib.parse.quote(user_id, safe="") + "/dm", self._message_body(content, message_id, reply_to, embeds, buttons, components, components_ttl_seconds))

    def interactions(self, wait=20):
        return self.request("GET", "/v2/bot/interactions?" + urllib.parse.urlencode({"wait": wait}))

    def reply(self, interaction_id, content, ephemeral=False):
        return self.request("POST", "/v2/bot/interactions/" + urllib.parse.quote(interaction_id, safe="") + "/reply", {"content": content, "ephemeral": ephemeral})

    def upload_avatar(self, image, animated=True):
        return self.request("PUT", "/v2/bot/users/me/" + ("avatar-media" if animated else "photo"), raw=image)

    def upload_banner(self, image):
        return self.request("PUT", "/v2/bot/users/me/profile-banner", raw=image)
