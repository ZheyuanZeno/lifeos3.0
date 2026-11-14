"""Local adapter for the shared Pocket operation protocol. No network or cloud credentials."""
import datetime as dt
import json
import re
import uuid

ENTITIES = ('modules', 'records', 'routines', 'completions', 'sessions')
ID = re.compile(r'^[a-zA-Z0-9_-]{1,100}$')


def setup(db):
    db.execute('CREATE TABLE IF NOT EXISTS pocket_operations (id TEXT PRIMARY KEY, entity TEXT NOT NULL, record_id TEXT NOT NULL, device_id TEXT NOT NULL, sequence INTEGER NOT NULL, clock INTEGER NOT NULL, payload TEXT NOT NULL)')
    db.execute('CREATE UNIQUE INDEX IF NOT EXISTS pocket_by_device_sequence ON pocket_operations(device_id, sequence)')
    db.execute('CREATE INDEX IF NOT EXISTS pocket_by_record ON pocket_operations(entity, record_id)')
    db.execute('CREATE TABLE IF NOT EXISTS pocket_entities (entity TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(entity,id))')
    db.execute('CREATE TABLE IF NOT EXISTS pocket_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')


def operations(db):
    return [json.loads(row[0]) for row in db.execute('SELECT payload FROM pocket_operations ORDER BY clock, device_id, id')]


def identity(db):
    saved = db.execute("SELECT value FROM pocket_meta WHERE key='identity'").fetchone()
    return json.loads(saved[0]) if saved else {'id': uuid.uuid4().hex, 'sequence': 0, 'clock': 0}


def put_identity(db, owner):
    db.execute("INSERT OR REPLACE INTO pocket_meta VALUES ('identity',?)", (json.dumps(owner),))


def validate_operation(op):
    if not isinstance(op, dict) or any(not isinstance(op.get(k), str) or not ID.fullmatch(op[k]) for k in ('id', 'deviceId', 'recordId')):
        raise ValueError('同步操作编号无效')
    if op.get('entity') not in ENTITIES or any(type(op.get(k)) is not int or op[k] < 1 or op[k] > 9007199254740991 for k in ('sequence', 'clock')):
        raise ValueError('同步操作类型或顺序无效')
    context = op.get('context')
    if not isinstance(context, dict) or any(not ID.fullmatch(k) or type(v) is not int or v < 0 for k, v in context.items()) or context.get(op['deviceId'], 0) >= op['sequence']:
        raise ValueError('同步因果顺序无效')
    patch = op.get('patch')
    if not isinstance(patch, dict) or any(k in ('id', '__proto__', 'prototype', 'constructor') for k in patch):
        raise ValueError('同步变更无效')
    stamp = dt.datetime.fromisoformat(op.get('timestamp', '').replace('Z', '+00:00'))
    if stamp.tzinfo is None:
        raise ValueError('同步时间缺少时区')


def add_operation(db, op):
    validate_operation(op)
    prior = db.execute('SELECT payload FROM pocket_operations WHERE id=?', (op['id'],)).fetchone()
    clean = {**op, 'uploaded': 1}
    if prior:
        if {**json.loads(prior[0]), 'uploaded': 1} != clean:
            raise ValueError('同步操作编号冲突')
        return
    db.execute('INSERT INTO pocket_operations VALUES (?,?,?,?,?,?,?)', (op['id'], op['entity'], op['recordId'], op['deviceId'], op['sequence'], op['clock'], json.dumps(clean, ensure_ascii=False)))


def capture(db, previous, doc):
    setup(db)
    owner = identity(db)
    all_ops = operations(db)
    context = {}
    for op in all_ops:
        context[op['deviceId']] = max(context.get(op['deviceId'], 0), op['sequence'])
        owner['clock'] = max(owner['clock'], op['clock'])
    for entity in ('modules', 'records'):
        old = {r['id']: r for r in previous.get(entity, [])}
        present = {r['id'] for r in doc[entity]}
        rows = list(doc[entity])
        for missing in previous.get(entity, []):
            if missing['id'] not in present:
                rows.append({**missing, ('deleted' if entity == 'records' else 'archived'): True})
        for row in rows:
            history = db.execute('SELECT 1 FROM pocket_operations WHERE entity=? AND record_id=? LIMIT 1', (entity, row['id'])).fetchone()
            patch = {k: v for k, v in row.items() if k != 'id' and (not history or old.get(row['id'], {}).get(k) != v)}
            if not patch:
                continue
            owner['sequence'] += 1
            owner['clock'] += 1
            op = {'id': uuid.uuid4().hex, 'deviceId': owner['id'], 'sequence': owner['sequence'], 'clock': owner['clock'], 'context': dict(context), 'entity': entity, 'recordId': row['id'], 'patch': patch, 'timestamp': dt.datetime.now(dt.timezone.utc).isoformat(), 'uploaded': 1}
            add_operation(db, op)
            context[owner['id']] = owner['sequence']
    put_identity(db, owner)


def materialize(ops):
    fields = {}
    for op in ops:
        for key in op['patch']:
            fields.setdefault(key, []).append(op)
    row = {'id': ops[0]['recordId']}
    for key, candidates in fields.items():
        normal = [op for op in candidates if op.get('origin') != 'seed']
        candidates = normal or candidates
        heads = [a for a in candidates if not any(b['id'] != a['id'] and b['context'].get(a['deviceId'], 0) >= a['sequence'] for b in candidates)]
        if not heads:
            raise ValueError('同步历史包含因果循环')
        if key in ('deleted', 'archived') and any(o['patch'][key] is True for o in heads):
            heads = [o for o in heads if o['patch'][key] is True]
        winner = max(heads, key=lambda o: (o['clock'], o['deviceId'], o['id']))
        row[key] = winner['patch'][key]
    if ops[0]['entity'] == 'sessions':
        keys = ('startedAt', 'endedAt', 'pauses')
        actions = [op for op in ops if any(k in op['patch'] for k in keys)]
        ended = [op for op in actions if isinstance(op['patch'].get('endedAt'), str)]
        def heads(items):
            return [a for a in items if not any(b['id'] != a['id'] and b['context'].get(a['deviceId'], 0) >= a['sequence'] for b in items)]
        candidates = heads(ended or actions)
        if candidates:
            winner = max(candidates, key=lambda o: (o['clock'], o['deviceId'], o['id']))
            ancestors = [o for o in ops if o['id'] == winner['id'] or winner['context'].get(o['deviceId'], 0) >= o['sequence']]
            for key in keys:
                row.pop(key, None)
                candidates = heads([o for o in ancestors if key in o['patch']])
                if candidates:
                    row[key] = max(candidates, key=lambda o: (o['clock'], o['deviceId'], o['id']))['patch'][key]
    return row


def validate_extension(entity, row):
    if not isinstance(row, dict) or not ID.fullmatch(str(row.get('id', ''))):
        raise ValueError('Pocket 编号无效')
    if 'deleted' in row and type(row['deleted']) is not bool:
        raise ValueError('Pocket 删除状态无效')
    for key in ('created_at', 'updated_at'):
        stamp = dt.datetime.fromisoformat(row.get(key, '').replace('Z', '+00:00'))
        if stamp.tzinfo is None:
            raise ValueError('Pocket 时间无效')
    if entity == 'routines':
        days = row.get('days')
        target = row.get('targetMinutes')
        minimum = row.get('minimumMinutes')
        if not isinstance(row.get('title'), str) or not row['title'].strip() or len(row['title']) > 200 or not isinstance(days, list) or not 1 <= len(days) <= 7 or any(type(d) is not int or not 0 <= d <= 6 for d in days) or type(target) not in (int, float) or not 1 <= target <= 1440 or (minimum is not None and (type(minimum) not in (int, float) or not 0 <= minimum <= target)) or type(row.get('archived')) is not bool:
            raise ValueError('例行事项无效')
    elif entity == 'completions':
        dt.date.fromisoformat(row.get('date', ''))
        if not ID.fullmatch(str(row.get('routineId', ''))) or row['id'] != row['routineId'] + '_' + row['date'] or type(row.get('completed')) is not bool:
            raise ValueError('每日完成记录无效')
    elif entity == 'sessions':
        if 'note' in row and (not isinstance(row['note'], str) or len(row['note'].encode('utf-16-le', errors='surrogatepass')) // 2 > 10000):
            raise ValueError('计时备注无效或超过 10000 字')
        start = dt.datetime.fromisoformat(row.get('startedAt', '').replace('Z', '+00:00'))
        end = dt.datetime.fromisoformat(row['endedAt'].replace('Z', '+00:00')) if row.get('endedAt') else None
        if start.tzinfo is None or (end and (end.tzinfo is None or end < start)) or row.get('subjectKind') not in ('routine', 'record') or not ID.fullmatch(str(row.get('subjectId', ''))) or not ID.fullmatch(str(row.get('deviceId', ''))) or not isinstance(row.get('timeZone'), str):
            raise ValueError('计时会话无效')
        pauses = row.get('pauses', [])
        if not isinstance(pauses, list) or len(pauses) > 1000:
            raise ValueError('暂停记录无效')
        boundary = start
        for index, pause in enumerate(pauses):
            if not isinstance(pause, dict) or not isinstance(pause.get('startedAt'), str) or 'endedAt' not in pause or (pause['endedAt'] is not None and not isinstance(pause['endedAt'], str)):
                raise ValueError('暂停记录无效')
            pause_start = dt.datetime.fromisoformat(pause['startedAt'].replace('Z', '+00:00'))
            pause_end = dt.datetime.fromisoformat(pause['endedAt'].replace('Z', '+00:00')) if pause['endedAt'] is not None else None
            if pause_start.tzinfo is None or pause_start < boundary or (pause_end is None and (index != len(pauses)-1 or end is not None)) or (pause_end is not None and (pause_end.tzinfo is None or pause_end < pause_start or (end is not None and pause_end > end))):
                raise ValueError('暂停时间顺序无效')
            boundary = pause_end or pause_start


def preview(db, doc, incoming, validate_module, validate_record):
    """Return a validated candidate; caller commits candidate and incoming in one SQLite transaction."""
    if not isinstance(incoming, list) or len(incoming) > 20000:
        raise ValueError('同步批次无效或过大')
    for op in incoming:
        validate_operation(op)
    merged = {op['id']: op for op in operations(db)}
    for op in incoming:
        if op['id'] in merged and {**merged[op['id']], 'uploaded': 1} != {**op, 'uploaded': 1}:
            raise ValueError('同步操作编号冲突')
        merged[op['id']] = op
    groups = {}
    for op in merged.values():
        groups.setdefault((op['entity'], op['recordId']), []).append(op)
    candidate = {**doc, 'modules': [], 'records': []}
    extensions = []
    for (entity, _), ops in groups.items():
        row = materialize(ops)
        if entity == 'modules':
            candidate['modules'].append(validate_module(row))
        elif entity == 'records':
            validated = validate_record(row)
            if validated != row:
                raise ValueError('同步记录字段与桌面格式不一致')
            candidate['records'].append(validated)
        else:
            validate_extension(entity, row)
            extensions.append((entity, row))
    # Keep stable board order; newly received modules follow existing modules.
    positions = {m['id']: i for i, m in enumerate(doc['modules'])}
    candidate['modules'].sort(key=lambda m: (positions.get(m['id'], len(positions)), m['id']))
    return candidate, extensions


def commit_remote(db, incoming, extensions):
    setup(db)
    for op in incoming:
        add_operation(db, op)
    for entity, row in extensions:
        db.execute('INSERT OR REPLACE INTO pocket_entities VALUES (?,?,?)', (entity, row['id'], json.dumps(row, ensure_ascii=False)))
