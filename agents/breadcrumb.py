#!/usr/bin/env python3
"""Local agent interface. Never edits the live manifest. Python 3 standard library only."""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import uuid
import urllib.request
import urllib.parse
from http_client import opener as http_opener

ACTIVITIES = ['Coding', 'Terminal work', 'Reading', 'Video page', 'Meeting app',
              'Messaging interface', 'AI assistant page', 'Social page', 'Calendar interface',
              'Developer page', 'Browser settings', 'Browsing', 'Music app', 'Email app', 'Unclassified']

def payload_for(library, capture_id):
    payload = json.loads((library / (capture_id + '.json')).read_text())
    ref = payload.pop('jpegRef', None)
    if ref:
        if len(ref) != 64 or any(c not in '0123456789abcdef' for c in ref):
            raise ValueError('Invalid screenshot reference')
        payload['jpeg'] = base64.b64encode((library / 'images' / (ref + '.jpg')).read_bytes()).decode()
    return payload

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    library_path = Path.home() / 'Library/Application Support/Breadcrumb'
    legacy_path = Path.home() / 'Library/Application Support/Rewind'
    if not library_path.exists() and legacy_path.exists():
        library_path = legacy_path
    parser.add_argument('--library', type=Path, default=library_path)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('sessions', help='Print local task sessions as JSON (metadata only)')
    sub.add_parser('list', help='Print capture metadata as JSON lines (dates: seconds since 2001-01-01 UTC)')
    show = sub.add_parser('show', help='Print accessibility payload; optionally extract screenshot')
    show.add_argument('id', type=uuid.UUID)
    show.add_argument('--jpeg', type=Path)
    label = sub.add_parser('label', help='Queue one suggestion; manual corrections take priority')
    label.add_argument('id', type=uuid.UUID)
    label.add_argument('activity', choices=ACTIVITIES)
    label.add_argument('--flag', action='append', default=[])
    label.add_argument('--reason', required=True)
    run = sub.add_parser('rules', help='Run editable if statements; preview unless --apply')
    run.add_argument('--file', type=Path, default=Path(__file__).with_name('rules.py'))
    run.add_argument('--apply', action='store_true')
    export = sub.add_parser('bundle', help='Prepare one selected capture for web upload; review before sharing')
    export.add_argument('id', type=uuid.UUID)
    export.add_argument('--output', type=Path, required=True)
    upload = sub.add_parser('upload', help='Explicitly contribute one capture, including its tree and screenshot')
    upload.add_argument('id', type=uuid.UUID)
    upload.add_argument('--server', required=True)
    upload.add_argument('--consent', action='store_true', required=True)
    upload.add_argument('--token-env', default='BREADCRUMB_UPLOAD_TOKEN')
    args = parser.parse_args()
    manifest = json.loads((args.library / 'library.json').read_text())
    records = manifest['observations']
    if args.command in ('bundle', 'upload'):
        record = next((r for r in records if r['id'].lower() == str(args.id)), None)
        if record is None:
            parser.error('Capture is not in the library')
        payload = payload_for(args.library, record['id'])
        bundle = dict(schemaVersion=1, consent=args.command == 'upload', record=record, payload=payload)
        data = json.dumps(bundle, ensure_ascii=False).encode()
        if args.command == 'bundle':
            # Avoid overwriting an existing file or creating a publicly readable bundle.
            fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'wb') as f:
                f.write(data)
            print(f'Prepared {args.output}; review before sharing. Consent is requested by the web uploader.')
            return
        origin = urllib.parse.urlparse(args.server)
        if (origin.scheme != 'https' and not (origin.scheme == 'http' and origin.hostname in ('localhost', '127.0.0.1'))
                or not origin.netloc or origin.username or origin.password or origin.query or origin.fragment
                or origin.path not in ('', '/')):
            parser.error('--server must be an HTTPS origin (HTTP localhost is allowed)')
        token = os.environ.get(args.token_env, '')
        if not token:
            parser.error(f'Set {args.token_env} to your upload token')
        def request(path, body, extra=None):
            req = urllib.request.Request(args.server.rstrip('/') + path, data=body,
                headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, **(extra or {})})
            with http_opener().open(req, timeout=90) as response:
                raw = response.read()
                return json.loads(raw) if raw else None
        if len(data) < 4 * 1024 * 1024:
            result = request('/v1/ingest', data)
        else:
            body = json.dumps(payload, ensure_ascii=False).encode()
            if len(body) > 12 * 1024 * 1024:
                parser.error('Capture payload exceeds 12 MiB')
            pending = request('/v1/uploads/start', json.dumps(dict(schemaVersion=1, consent=True,
                record=record, size=len(body), sha256=hashlib.sha256(body).hexdigest())).encode())
            size = pending['chunkSize']
            if not isinstance(size, int) or not 1 <= size <= 3 * 1024 * 1024:
                raise ValueError('Invalid server chunk size')
            for index, offset in enumerate(range(0, len(body), size)):
                request('/v1/uploads/chunk?index=' + str(index), body[offset:offset+size],
                    {'Content-Type': 'application/octet-stream', 'X-Upload-ID': pending['uploadId']})
            result = request('/v1/uploads/complete', json.dumps({'uploadId': pending['uploadId']}).encode())
        print(json.dumps(result))
        return
    if args.command == 'sessions':
        sessions = []
        for record in sorted(records, key=lambda r: (r['date'], r['id'])):
            context = record.get('context') or {}
            key = context.get('project') or context.get('domain') or record['bundleID']
            if sessions and sessions[-1]['key'] == key and record['date'] - sessions[-1]['end'] <= 180:
                sessions[-1]['end'] = record['date']
                sessions[-1]['ids'].append(record['id'])
            elif len(sessions) >= 2 and sessions[-2]['key'] == key and record['date'] - sessions[-2]['end'] <= 120:
                interruption = sessions.pop()
                sessions[-1]['ids'] += interruption['ids'] + [record['id']]
                sessions[-1]['end'] = record['date']
            else:
                sessions.append(dict(key=key, title=context.get('project') or context.get('domain') or record['app'],
                                     start=record['date'], end=record['date'], ids=[record['id']]))
        print(json.dumps(sessions, ensure_ascii=False, indent=2))
        return
    if args.command == 'list':
        for record in records:
            print(json.dumps(record, ensure_ascii=False))
        return
    if args.command == 'show':
        if not any(r['id'].lower() == str(args.id) for r in records):
            parser.error('Capture is not in the library')
        record = next(r for r in records if r['id'].lower() == str(args.id))
        payload = payload_for(args.library, record['id'])
        if args.jpeg:
            args.jpeg.write_bytes(base64.b64decode(payload['jpeg']))
        print(json.dumps({'tree': payload['tree'], 'screenText': payload.get('screenText')}, ensure_ascii=False, indent=2))
        return
    if args.command == 'label':
        if not any(r['id'].lower() == str(args.id) for r in records):
            parser.error('Capture is not in the library')
        labels = [dict(id=str(args.id), activity=args.activity, flags=args.flag, reason=args.reason)]
        apply = True
    else:
        spec = importlib.util.spec_from_file_location('breadcrumb_rules', args.file)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        labels = []
        for record in records:
            result = module.classify(record)
            if result is not None:
                labels.append(dict(result, id=record['id']))
        apply = args.apply
    for label in labels:
        if (label.get('activity') not in ACTIVITIES or not isinstance(label.get('reason'), str)
                or len(label['reason']) > 1000 or not isinstance(label.get('flags'), list)
                or len(label['flags']) > 20
                or any(not isinstance(f, str) or len(f) > 100 for f in label['flags'])):
            parser.error('Invalid rule result: expected activity, reason (<=1000 chars), flags (<=20 strings, <=100 chars each)')
    if apply and labels:
        inbox = args.library / 'inbox'
        inbox.mkdir(mode=0o700, exist_ok=True)
        pending = inbox / (str(uuid.uuid4()) + '.tmp')
        fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as f:
            json.dump(labels, f, ensure_ascii=False)
        pending.replace(pending.with_suffix('.json'))
    print(json.dumps({'queued': bool(apply and labels), 'labels': labels}, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
