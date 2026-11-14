import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'lifeos'))
import notification_proxy as proxy


class Response(io.BytesIO):
    code = 200


class NotificationRelayTests(unittest.TestCase):
    def test_only_named_routes_and_bounded_requests_can_reach_the_fixed_backend(self):
        with patch.object(proxy, 'build_opener') as opener:
            for route, method in [('https://evil.example', 'GET'), ('../state', 'PUT'), ('state', 'GET')]:
                self.assertEqual(proxy.relay(method, route, '')[1], 404)
            self.assertEqual(proxy.relay('PUT', 'state', '', b'x' * (proxy.LIMIT + 1))[1], 413)
            self.assertEqual(proxy.relay('GET', 'status', 'x' * 5000)[1], 413)
            opener.assert_not_called()

    def test_device_bearer_is_forwarded_only_to_canonical_notify_api(self):
        with patch.object(proxy, 'build_opener') as opener:
            opener.return_value.open.return_value = Response(b'{"ok":true}')
            result, status = proxy.relay('PUT', 'state', 'Bearer device-test', b'{"operations":[]}')
            self.assertEqual((result, status), ({'ok': True}, 200))
            request = opener.return_value.open.call_args.args[0]
            self.assertEqual(request.full_url, 'https://lifeos-pocket.pages.dev/api/notify/state')
            self.assertEqual(request.headers['Authorization'], 'Bearer device-test')
            self.assertEqual(request.headers['User-agent'], 'LifeOSDesktop/1.0')
            self.assertNotIn('X-Lifeos-Token', request.headers)

    def test_bad_or_oversized_upstream_response_becomes_a_bounded_error(self):
        for data in [b'<html>bad gateway</html>', b'x' * (proxy.LIMIT + 1)]:
            with patch.object(proxy, 'build_opener') as opener:
                opener.return_value.open.return_value = Response(data)
                self.assertEqual(proxy.relay('GET', 'config', '')[1], 502)

    def test_redirects_are_never_followed(self):
        self.assertIsNone(proxy.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://evil.example'))


if __name__ == '__main__':
    unittest.main()
