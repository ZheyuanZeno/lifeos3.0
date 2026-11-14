"""Portable validation and progress ranking for Pocket background workflows."""
import datetime as dt
import json
import re


def parse(value):
    if not isinstance(value, str) or len(value.encode('utf-16-le')) // 2 > 10000:
        raise ValueError('后台流程格式无效')
    flow = json.loads(value)
    ident = lambda v: isinstance(v, str) and re.fullmatch(r'[a-zA-Z0-9_-]{1,100}', v)
    def stamp(v):
        if not isinstance(v, str):
            raise ValueError('流程时间无效')
        t = dt.datetime.fromisoformat(v.replace('Z', '+00:00'))
        if t.tzinfo is None:
            raise ValueError('流程时间缺少时区')
        return t.timestamp()
    if not isinstance(flow, dict) or type(flow.get('version')) not in (int, float) or flow.get('version') != 1 or not ident(flow.get('id')) or set(flow) - {'version', 'id', 'steps', 'startedAt', 'endedAt'} or not isinstance(flow.get('steps'), list) or not 1 <= len(flow['steps']) <= 12:
        raise ValueError('后台流程格式无效')
    start = stamp(flow['startedAt']) if 'startedAt' in flow else None
    end = stamp(flow['endedAt']) if 'endedAt' in flow else None
    if end is not None and (start is None or end < start):
        raise ValueError('流程时间无效')
    boundary = start or 0
    blocked = False
    ids = set()
    for s in flow['steps']:
        if not isinstance(s, dict) or set(s) - {'id', 'title', 'minutes', 'startedAt', 'expectedEndAt', 'handledAt'} or not ident(s.get('id')) or s['id'] in ids or not isinstance(s.get('title'), str) or not s['title'].strip() or len(s['title'].encode('utf-16-le')) // 2 > 60 or type(s.get('minutes')) not in (int, float) or not 1 <= s['minutes'] <= 10080 or s['minutes'] != int(s['minutes']):
            raise ValueError('阶段名称或时长无效')
        ids.add(s['id'])
        if 'startedAt' not in s:
            if 'expectedEndAt' in s or 'handledAt' in s:
                raise ValueError('阶段时间无效')
            blocked = True
            continue
        t = stamp(s['startedAt'])
        if blocked or start is None or t < boundary or abs(stamp(s.get('expectedEndAt')) - t - s['minutes'] * 60) > 0.0001:
            raise ValueError('阶段时间顺序无效')
        handled = stamp(s['handledAt']) if 'handledAt' in s else None
        if handled is not None and handled < t:
            raise ValueError('处理时间无效')
        boundary = handled if handled is not None else t
        blocked = handled is None
        if end is not None and boundary > end:
            raise ValueError('流程结束时间无效')
    return flow


def rank(flow):
    return (100 if flow.get('endedAt') else 0) + (1 if flow.get('startedAt') else 0) + sum(bool(s.get('startedAt')) + bool(s.get('handledAt')) for s in flow['steps'])
