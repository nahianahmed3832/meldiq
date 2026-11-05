"""Meldiq's native Bot HTTP API. Python 3.10+, standard library only."""
import json
import uuid
import posixpath
import re
import http.client
import time
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

    def _response(self, method, path, body=None, raw=None, binary=False, byte_range=None):
        url = urllib.parse.urljoin(self.api_origin + "/", path)
        parsed = urllib.parse.urlsplit(url)
        decoded_path = urllib.parse.unquote(parsed.path)
        if urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "", "", "")) != self.api_origin or not posixpath.normpath(decoded_path).startswith("/v2/bot/") or parsed.fragment:
            raise ValueError("Only native /v2/bot/ paths on the configured origin are allowed")
        if method not in ("GET", "POST", "PUT", "PATCH", "DELETE") or (body is not None and raw is not None):
            raise ValueError("Invalid bot request")
        if byte_range is not None and (method != "GET" or not isinstance(byte_range, str) or not re.fullmatch(r"bytes=\d+-\d*", byte_range)):
            raise ValueError("Invalid attachment range")
        headers = {"Authorization": "Bot " + self._token, "Accept": "application/octet-stream" if binary else "application/json"}
        if byte_range is not None:
            headers["Range"] = byte_range
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
        return response

    def _decode_response(self, response):
        try:
            value = response.read(self.max_response_bytes + 1)
        except (OSError, http.client.HTTPException):
            raise MeldiqBotError(0, "network_error", "The bot API response was interrupted") from None
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

    def request(self, method, path, body=None, raw=None):
        with self._response(method, path, body=body, raw=raw) as response:
            return self._decode_response(response)

    def upload_attachment(self, channel_id, ciphertext):
        if not isinstance(ciphertext, (bytes, bytearray, memoryview)) or not len(ciphertext):
            raise ValueError("Encrypted attachment bytes are required")
        return self.request("POST", "/v2/bot/attachments?" + urllib.parse.urlencode({"conversationId": channel_id}), raw=ciphertext)

    def start_upload(self, channel_id, size, sha256):
        return self.request("POST", "/v2/bot/attachments/uploads", {"conversationId": channel_id, "size": size, "sha256": sha256})

    def upload_url(self, upload_id):
        return self.request("POST", "/v2/bot/attachments/uploads/" + urllib.parse.quote(upload_id, safe="") + "/url")

    def sign_upload_parts(self, upload_id, parts):
        return self.request("POST", "/v2/bot/attachments/uploads/" + urllib.parse.quote(upload_id, safe="") + "/parts", {"parts": parts})

    def uploaded_parts(self, upload_id):
        return self.request("GET", "/v2/bot/attachments/uploads/" + urllib.parse.quote(upload_id, safe="") + "/parts")

    def complete_upload(self, upload_id, parts=None):
        return self.request("POST", "/v2/bot/attachments/uploads/" + urllib.parse.quote(upload_id, safe="") + "/complete", {"parts": parts} if parts is not None else {})

    def cancel_upload(self, upload_id):
        return self.request("DELETE", "/v2/bot/attachments/uploads/" + urllib.parse.quote(upload_id, safe=""))

    def download_attachment(self, attachment_id, byte_range=None, chunk_size=65536):
        if not isinstance(chunk_size, int) or not 1024 <= chunk_size <= 1024 * 1024:
            raise ValueError("Invalid download chunk size")
        deadline = time.monotonic() + self.timeout
        try:
            with self._response("GET", "/v2/bot/attachments/" + urllib.parse.quote(attachment_id, safe=""), binary=True, byte_range=byte_range) as response:
                if not 200 <= response.status < 300:
                    self._decode_response(response)
                while True:
                    chunk = response.read(chunk_size)
                    if time.monotonic() > deadline:
                        raise MeldiqBotError(0, "download_failed", "The attachment download timed out")
                    if not chunk:
                        break
                    yield chunk
        except (OSError, http.client.HTTPException):
            raise MeldiqBotError(0, "download_failed", "The attachment download was interrupted") from None

    def me(self):
        return self.request("GET", "/v2/bot/me")

    def communities(self):
        return self.request("GET", "/v2/bot/communities")

    def events(self, cursor=None, limit=50):
        return self.request("GET", "/v2/bot/events?" + urllib.parse.urlencode({"limit": limit, **({"cursor": cursor} if cursor else {})}))

    def _message_body(self, content, message_id, reply_to, embeds, buttons, components, components_ttl_seconds, attachments=None):
        optional = {"messageId": message_id, "replyTo": reply_to, "embeds": embeds, "buttons": buttons, "components": components, "componentsTtlSeconds": components_ttl_seconds, "attachments": attachments}
        return {"content": content, **{key: value for key, value in optional.items() if value is not None}}

    def send(self, channel_id, content, message_id=None, *, reply_to=None, embeds=None, buttons=None, components=None, components_ttl_seconds=None, attachments=None):
        return self.request("POST", "/v2/bot/channels/" + urllib.parse.quote(channel_id, safe="") + "/messages", self._message_body(content, message_id, reply_to, embeds, buttons, components, components_ttl_seconds, attachments))

    def set_commands(self, commands):
        return self.request("PUT", "/v2/bot/commands", {"commands": commands})

    def join_voice(self, channel_id, request_id=None, *, wait_for_member=False):
        if not isinstance(wait_for_member, bool):
            raise TypeError("wait_for_member must be a boolean")
        body = {"channelId": channel_id, "requestId": request_id or str(uuid.uuid4())}
        if wait_for_member:
            body["waitForMember"] = True
        return self.request("POST", "/v2/bot/voice", body)

    def voice_key(self, lease_id):
        return self.request("GET", "/v2/bot/voice/" + urllib.parse.quote(lease_id, safe="") + "/key")

    def renew_voice(self, lease_id):
        return self.request("POST", "/v2/bot/voice/" + urllib.parse.quote(lease_id, safe="") + "/heartbeat")

    def voice_connected(self, lease_id):
        return self.request("POST", "/v2/bot/voice/" + urllib.parse.quote(lease_id, safe="") + "/connected")

    def leave_voice(self, lease_id):
        return self.request("DELETE", "/v2/bot/voice/" + urllib.parse.quote(lease_id, safe=""))

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
