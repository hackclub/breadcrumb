#!/usr/bin/env python3
"""Review a claimed capture through Vercel AI Gateway (explicit worker invocation only)."""
import json
import os
from pathlib import Path
import sys
import urllib.request
from http_client import opener as http_opener

ENDPOINT = 'https://ai-gateway.vercel.sh/v1/chat/completions'
VERSION = 'breadcrumb-multiactivity-v1'

def review(job, api_key, model, opener=None):
    capture = job['capture']['upload']
    payload = capture['payload']
    # Do not send job lease credentials, participant IDs, or auth metadata to a model.
    evidence = {'record': capture['record'], 'tree': payload.get('tree', []),
                'screenText': payload.get('screenText')}
    content = [{'type': 'text', 'text': json.dumps(evidence, ensure_ascii=False)}]
    if payload.get('jpeg'):
        content.append({'type': 'image_url', 'image_url': {'url': 'data:image/jpeg;base64,' + payload['jpeg']}})
    instructions = Path(__file__).with_name('REVIEWING.md').read_text()
    request = urllib.request.Request(ENDPOINT, data=json.dumps({
        'model': model,
        'messages': [{'role': 'system', 'content': instructions + '\nReturn only the review JSON object. Do not invent temporal history from one capture. Session should be a project/task hint, not a claimed duration.'},
                     {'role': 'user', 'content': content}],
        'response_format': {'type': 'json_object'},
        'max_tokens': 2000,
    }).encode(), headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + api_key})
    opener = opener or http_opener()
    with opener.open(request, timeout=180) as response:
        raw = response.read(256_001)
        if len(raw) > 256_000:
            raise ValueError('Gateway response too large')
        envelope = json.loads(raw)
    choice = envelope['choices'][0]
    if choice.get('finish_reason') not in (None, 'stop'):
        raise ValueError('Gateway response incomplete: ' + str(choice.get('finish_reason')))
    result = json.loads(choice['message']['content'])
    result['model'] = envelope.get('model') or model
    result['version'] = VERSION
    # Only allow review fields. Server stamps identity and time itself.
    return {key: result[key] for key in ('model', 'version', 'summary', 'session', 'labels', 'flags')}

def main():
    api_key = os.environ.get('AI_GATEWAY_API_KEY')
    model = os.environ.get('AI_GATEWAY_MODEL')
    if not api_key or not model:
        raise SystemExit('Set AI_GATEWAY_API_KEY and AI_GATEWAY_MODEL to a vision model supporting JSON output')
    print(json.dumps(review(json.load(sys.stdin), api_key, model), ensure_ascii=False))

if __name__ == '__main__':
    main()
