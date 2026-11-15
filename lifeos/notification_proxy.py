"""Bounded same-origin relay; notification credentials never enter SQLite or logs."""
import json
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener, HTTPRedirectHandler

LIMIT = 2 * 1024 * 1024
METHODS = {'config': {'GET'}, 'enroll': {'POST'}, 'state': {'PUT'},
           'subscription': {'PUT', 'DELETE'}, 'test': {'POST'},
           'device': {'DELETE'}, 'status': {'GET'}}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def relay(method, route, authorization, raw=None, native=False):
    methods = {key: {"POST"} for key in ("enroll", "pair", "revoke", "projection", "pending", "ack")} if native else METHODS
    if method not in methods.get(route, set()):
        return {'error': '未找到通知接口'}, 404
    if len(authorization) > 4096 or raw is not None and len(raw) > LIMIT:
        return {'error': '通知请求超过限制'}, 413
    headers = {'Content-Type': 'application/json', 'Accept': 'application/json',
               'User-Agent': 'LifeOSDesktop/1.0'}
    if authorization:
        headers['Authorization'] = authorization
    request = Request(('https://lifeos-pocket.pages.dev/api/mcp-device/' if native else 'https://lifeos-pocket.pages.dev/api/notify/') + route,
                      data=raw, headers=headers, method=method)
    try:
        try:
            response = build_opener(NoRedirect).open(request, timeout=22)
        except HTTPError as exc:
            response = exc
        with response:
            payload = response.read(LIMIT + 1)
            if len(payload) > LIMIT:
                raise ValueError('通知响应超过限制')
            return json.loads(payload), response.code
    except (URLError, OSError, ValueError):
        return {'error': '通知服务连接失败，请稍后重试'}, 502
