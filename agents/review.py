#!/usr/bin/env python3
"""Claim corpus work and invoke an agent command over JSON stdin/stdout."""
import argparse
import base64
import json
import os
import shlex
import subprocess
import urllib.parse
import urllib.request
from http_client import opener as http_opener


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--server', required=True)
    parser.add_argument('--token-env', default='BREADCRUMB_REVIEW_TOKEN')
    parser.add_argument('--reviewer-cmd', nargs=argparse.REMAINDER, help='Cross-platform reviewer executable and arguments; must be last')
    parser.add_argument('--reviewer', help='Command accepting the job JSON on stdin and returning review JSON on stdout')
    parser.add_argument('--max-jobs', type=int, default=1)
    parser.add_argument('--index', action='store_true', help='Index existing uploads, then exit')
    args = parser.parse_args()
    origin = urllib.parse.urlparse(args.server)
    if (origin.scheme != 'https' and not (origin.scheme == 'http' and origin.hostname in ('localhost', '127.0.0.1'))
            or not origin.netloc or origin.username or origin.password or origin.query or origin.fragment
            or origin.path not in ('', '/')):
        parser.error('--server must be an HTTPS origin (HTTP localhost is allowed)')
    token = os.environ.get(args.token_env)
    if not token:
        parser.error(f'Set {args.token_env} to a review-agent token')
    if not args.index and ((not args.reviewer and not args.reviewer_cmd) or args.max_jobs < 1):
        parser.error('--reviewer and positive --max-jobs required')

    opener = http_opener()

    def request(path, body):
        req = urllib.request.Request(args.server.rstrip('/') + path, json.dumps(body).encode(),
                                     headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token})
        with opener.open(req, timeout=90) as response:
            return json.loads(response.read()) if response.status != 201 else None

    cursor = ''
    if args.index:
        while True:
            result = request('/v1/review/index?cursor=' + urllib.parse.quote(cursor, safe=''), {})
            print(json.dumps(result), flush=True)
            cursor = result.get('nextCursor') or ''
            if not cursor:
                return
    completed = 0
    while completed < args.max_jobs:
        job = request('/v1/review/claim?cursor=' + urllib.parse.quote(cursor, safe=''), {})
        if not job.get('job'):
            cursor = job.get('nextCursor') or ''
            if cursor:
                continue
            print(json.dumps({'completed': completed, 'status': 'no claimable jobs'}))
            return
        if job.get('captureURL'):
            url = urllib.parse.urlparse(job['captureURL'])
            if url.scheme != 'https' or url.username or url.password:
                raise ValueError('Invalid signed capture URL')
            # Signed R2 URLs authorize only this object. Never forward the review token.
            with opener.open(urllib.request.Request(job['captureURL']), timeout=90) as response:
                raw = response.read(13 * 1024 * 1024)
            if len(raw) > 12 * 1024 * 1024:
                raise ValueError('Capture exceeds 12 MiB')
            job['capture'] = json.loads(raw)
            del job['captureURL']
        if job.get('screenshotURL'):
            url = urllib.parse.urlparse(job['screenshotURL'])
            if url.scheme != 'https' or url.username or url.password:
                raise ValueError('Invalid signed screenshot URL')
            with opener.open(urllib.request.Request(job['screenshotURL']), timeout=90) as response:
                image = response.read(8 * 1024 * 1024 + 1)
            if len(image) > 8 * 1024 * 1024:
                raise ValueError('Screenshot exceeds 8 MiB')
            job['capture']['upload']['payload']['jpeg'] = base64.b64encode(image).decode()
            del job['screenshotURL']
        # No shell evaluation and no hidden model destination. The configured command
        # chooses how/where to run its model. Credentials are not passed on stdin.
        command_env = {key: os.environ[key] for key in (
            'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'VIRTUAL_ENV', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
            'AI_GATEWAY_API_KEY', 'AI_GATEWAY_MODEL') if key in os.environ}
        agent_input = {key: value for key, value in job.items() if key not in ('lease', 'generation')}
        output = subprocess.run(args.reviewer_cmd or shlex.split(args.reviewer), input=json.dumps(agent_input), text=True,
                                capture_output=True, timeout=480, check=True, env=command_env)
        if len(output.stdout.encode()) > 120_000:
            raise ValueError('Agent result exceeds 120 KB')
        result = json.loads(output.stdout)
        result.update(job=job['job'], lease=job['lease'], generation=job['generation'])
        request('/v1/review/submit', result)
        completed += 1
        print(json.dumps({'job': job['job'], 'status': 'reviewed'}), flush=True)

if __name__ == '__main__':
    main()
