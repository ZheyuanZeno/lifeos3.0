"""Fixed-origin signed Sync Hub relay; never stores device keys."""
import json
import os
import re
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener
from notification_proxy import NoRedirect

ACTIONS = {'create', 'status', 'pair/request', 'pair/approve', 'pair/claim', 'recover', 'recovery/rotate', 'device/revoke', 'batch/put', 'batch/get', 'changes', 'media/status', 'media/begin', 'media/put', 'media/commit', 'media/get', 'cursor/ack', 'manifest', 'archive/register', 'archive/rebind', 'archive/ack', 'migration/prepare', 'migration/verify', 'activate'}


def relay(action, incoming, raw):
    if action not in ACTIONS:
        return {'error': '未找到同步接口'}, 404
    if len(raw) > 2 * 1024 * 1024:
        return {'error': '同步请求过大'}, 413
    headers = {'Content-Type': 'application/json', 'User-Agent': 'LifeOSDesktop/1.0'}
    for suffix in ('Space', 'Device', 'Time', 'Nonce', 'Signature'):
        key = 'X-LifeOS-' + suffix
        value = incoming.get(key, '')
        if len(value) > 512:
            return {'error': '签名头过大'}, 413
        headers[key] = value
    try:
        # Only the test harness may select a loopback workerd endpoint; requests cannot set it.
        test_endpoint = os.environ.get('LIFEOS_SYNC_TEST_ENDPOINT', '')
        endpoint = test_endpoint if re.fullmatch(r'http://127\.0\.0\.1:\d+', test_endpoint) else 'https://lifeos-sync.lifeos-pocket.workers.dev'
        request = Request(endpoint + '/v1/' + action, raw, headers)
        try:
            result = build_opener(NoRedirect).open(request, timeout=25)
        except HTTPError as error:
            result = error
        with result:
            content = result.read(2 * 1024 * 1024 + 1)
            if len(content) > 2 * 1024 * 1024:
                raise ValueError('Response exceeds limit')
            return json.loads(content), result.code
    except (URLError, OSError, ValueError):
        return {'error': '自动同步服务不可达，本机修改已保留', 'code': 'network'}, 502
