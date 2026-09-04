#!/usr/bin/env python3
import argparse
import json
import mimetypes
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

SUPABASE_URL = os.environ['SUPABASE_URL'].rstrip('/')
SERVICE_KEY = os.environ['SUPABASE_SERVICE_ROLE_KEY']
BUCKET = os.environ.get('SUPABASE_BUCKET', 'tubegrab-temp')
COOKIE_FILE = os.environ['YOUTUBE_COOKIE_FILE']


def api(path, method='GET', payload=None, extra_headers=None):
    headers = {
        'apikey': SERVICE_KEY,
        'Authorization': f'Bearer {SERVICE_KEY}',
    }
    body = None
    if payload is not None:
        body = json.dumps(payload).encode()
        headers['Content-Type'] = 'application/json'
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(f'{SUPABASE_URL}{path}', data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            raw = response.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode('utf-8', 'replace')[:1000]
        raise RuntimeError(f'Supabase HTTP {exc.code}: {detail}') from exc


def patch_job(job_id, **changes):
    changes['updated_at'] = datetime.now(timezone.utc).isoformat()
    api(f'/rest/v1/tubegrab_jobs?id=eq.{urllib.parse.quote(job_id)}', method='PATCH', payload=changes)


def safe_error(text):
    lower = text.lower()
    if 'private video' in lower:
        return 'That video is private.'
    if 'video unavailable' in lower:
        return 'That video is unavailable.'
    if 'sign in to confirm' in lower or 'login_required' in lower:
        return 'YouTube rejected the authenticated worker session. The TubeGrab session may need refreshing.'
    if 'max-filesize' in lower or 'larger than max' in lower:
        return 'The requested file is larger than TubeGrab allows.'
    return 'The cloud download failed. Please try again.'


def fmt_selector(quality):
    return {
        '360': 'bv*[height<=360]+ba/b[height<=360]/b',
        '720': 'bv*[height<=720]+ba/b[height<=720]/b',
        '1080': 'bv*[height<=1080]+ba/b[height<=1080]/b',
    }.get(str(quality), 'bv*[height<=720]+ba/b[height<=720]/b')


def run_download(args, output_dir):
    output_template = str(output_dir / '%(title).120B [%(id)s].%(ext)s')
    cmd = [
        'yt-dlp', '--js-runtimes', 'node', '--remote-components', 'ejs:github',
        '--cookies', COOKIE_FILE,
        '--no-playlist', '--newline', '--no-colors', '--windows-filenames',
        '--progress-template', 'download:PROGRESS:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
        '--print', 'before_dl:TITLE:%(title)s',
        '--print', 'after_move:FINAL_FILE:%(filepath)s',
        '--max-filesize', f'{args.max_file_mb}M',
        '-o', output_template,
    ]
    if args.type == 'audio':
        cmd += ['-x', '--audio-format', 'mp3', '--audio-quality', '0']
    else:
        cmd += ['-f', fmt_selector(args.quality), '--merge-output-format', 'mp4']
    cmd.append(args.url)

    final_file = None
    last_progress_push = 0.0
    log_tail = []
    process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    assert process.stdout is not None
    for raw in process.stdout:
        line = raw.rstrip()
        print(line, flush=True)
        log_tail.append(line)
        log_tail[:] = log_tail[-80:]
        if line.startswith('TITLE:'):
            patch_job(args.job_id, title=line[6:].strip(), phase='downloading', status='running')
        elif line.startswith('FINAL_FILE:'):
            final_file = Path(line[len('FINAL_FILE:'):].strip())
        elif line.startswith('PROGRESS:'):
            parts = line[len('PROGRESS:'):].split('|')
            match = re.search(r'([0-9.]+)', parts[0] if parts else '')
            now = time.monotonic()
            if match and (now - last_progress_push >= 1.5):
                patch_job(
                    args.job_id,
                    status='running', phase='downloading',
                    progress=float(match.group(1)),
                    speed=(parts[1].strip() if len(parts) > 1 else None),
                    eta=(parts[2].strip() if len(parts) > 2 else None),
                )
                last_progress_push = now
        elif any(marker in line for marker in ('[Merger]', '[ExtractAudio]', '[VideoRemuxer]', '[Fixup')):
            patch_job(args.job_id, status='running', phase='processing')

    code = process.wait()
    if code != 0:
        raise RuntimeError('\n'.join(log_tail))
    if final_file is None or not final_file.exists():
        candidates = [p for p in output_dir.iterdir() if p.is_file() and not p.name.endswith('.part')]
        candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
        final_file = candidates[0] if candidates else None
    if final_file is None or not final_file.exists():
        raise RuntimeError('yt-dlp completed but produced no final file')
    return final_file


def upload_file(job_id, file_path):
    ext = file_path.suffix.lower() or '.bin'
    object_path = f'{job_id}/media{ext}'
    encoded = '/'.join(urllib.parse.quote(part, safe='') for part in object_path.split('/'))
    content_type = mimetypes.guess_type(file_path.name)[0] or 'application/octet-stream'
    endpoint = f'{SUPABASE_URL}/storage/v1/object/{urllib.parse.quote(BUCKET, safe="")}/{encoded}'
    cmd = [
        'curl', '--fail', '--silent', '--show-error', '-X', 'POST', endpoint,
        '-H', f'apikey: {SERVICE_KEY}',
        '-H', f'Authorization: Bearer {SERVICE_KEY}',
        '-H', f'Content-Type: {content_type}',
        '-H', 'x-upsert: false',
        '--data-binary', f'@{file_path}',
    ]
    subprocess.run(cmd, check=True)
    return object_path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--job-id', required=True)
    parser.add_argument('--url', required=True)
    parser.add_argument('--type', choices=['video', 'audio'], default='video')
    parser.add_argument('--quality', choices=['360', '720', '1080'], default='720')
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--max-file-mb', type=int, default=750)
    parser.add_argument('--max-duration-sec', type=int, default=7200)
    args = parser.parse_args()
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    try:
        patch_job(args.job_id, status='running', phase='starting', progress=0, error=None)

        # Metadata check uses the same authenticated session as the real download.
        meta_cmd = [
            'yt-dlp', '--js-runtimes', 'node', '--remote-components', 'ejs:github',
            '--cookies', COOKIE_FILE, '--dump-single-json', '--skip-download', '--no-playlist', '--no-warnings', args.url,
        ]
        meta = json.loads(subprocess.check_output(meta_cmd, text=True, stderr=subprocess.STDOUT))
        title = meta.get('title') or 'YouTube download'
        duration = meta.get('duration')
        if meta.get('is_live') or meta.get('live_status') == 'is_live':
            raise RuntimeError('LIVE_STREAM_NOT_SUPPORTED')
        if duration and float(duration) > args.max_duration_sec:
            raise RuntimeError('VIDEO_TOO_LONG')
        patch_job(args.job_id, title=title, status='running', phase='preparing')

        final_file = run_download(args, output_dir)
        size = final_file.stat().st_size
        if size > args.max_file_mb * 1024 * 1024:
            raise RuntimeError('OUTPUT_TOO_LARGE')

        patch_job(args.job_id, status='running', phase='uploading', progress=100, speed=None, eta=None)
        object_path = upload_file(args.job_id, final_file)
        expires = datetime.now(timezone.utc) + timedelta(hours=2)
        patch_job(
            args.job_id,
            status='complete', phase='complete', progress=100,
            object_path=object_path, file_name=final_file.name, file_size=size,
            expires_at=expires.isoformat(), speed=None, eta=None, error=None,
        )
        print(f'TUBEGAB_SUCCESS object={object_path} bytes={size}', flush=True)
    except Exception as exc:
        message = str(exc)
        print(f'TUBEGAB_FAILURE: {message}', file=sys.stderr, flush=True)
        if message == 'VIDEO_TOO_LONG':
            public = f'Video is longer than TubeGrab\'s {round(args.max_duration_sec / 60)} minute limit.'
        elif message == 'LIVE_STREAM_NOT_SUPPORTED':
            public = 'Live streams are not supported yet.'
        elif message == 'OUTPUT_TOO_LARGE':
            public = f'The finished file exceeded TubeGrab\'s {args.max_file_mb} MB limit.'
        else:
            public = safe_error(message)
        try:
            patch_job(args.job_id, status='failed', phase='failed', error=public, speed=None, eta=None)
        except Exception as patch_exc:
            print(f'Could not update failed job: {patch_exc}', file=sys.stderr)
        raise


if __name__ == '__main__':
    main()
