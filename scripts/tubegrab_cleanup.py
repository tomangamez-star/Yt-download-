#!/usr/bin/env python3
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

SUPABASE_URL = os.environ['SUPABASE_URL'].rstrip('/')
SERVICE_KEY = os.environ['SUPABASE_SERVICE_ROLE_KEY']
BUCKET = os.environ.get('SUPABASE_BUCKET', 'tubegrab-temp')


def request(path, method='GET', payload=None):
    headers = {'apikey': SERVICE_KEY, 'Authorization': f'Bearer {SERVICE_KEY}'}
    data = None
    if payload is not None:
        data = json.dumps(payload).encode()
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(f'{SUPABASE_URL}{path}', data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            raw = response.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode('utf-8', 'replace')[:1000]
        raise RuntimeError(f'HTTP {exc.code}: {detail}') from exc


def main():
    now = datetime.now(timezone.utc).isoformat()
    query = urllib.parse.urlencode({
        'status': 'eq.complete',
        'expires_at': f'lte.{now}',
        'object_path': 'not.is.null',
        'select': 'id,object_path',
        'limit': '100',
    })
    rows = request(f'/rest/v1/tubegrab_jobs?{query}') or []
    print(f'Expired objects found: {len(rows)}')
    for row in rows:
        object_path = row['object_path']
        try:
            request(f'/storage/v1/object/{urllib.parse.quote(BUCKET, safe="")}', method='DELETE', payload={'prefixes': [object_path]})
            request(
                f'/rest/v1/tubegrab_jobs?id=eq.{urllib.parse.quote(row["id"])}',
                method='PATCH',
                payload={'status': 'expired', 'phase': 'expired', 'object_path': None, 'updated_at': datetime.now(timezone.utc).isoformat()},
            )
            print(f'Deleted {object_path}')
        except Exception as exc:
            print(f'Cleanup failed for {object_path}: {exc}')


if __name__ == '__main__':
    main()
