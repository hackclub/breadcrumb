"""Verified HTTPS using the platform CA bundle, including python.org macOS installs."""
import os
from pathlib import Path
import ssl
import urllib.request

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def opener():
    cafile = os.environ.get('SSL_CERT_FILE')
    if not cafile and Path('/etc/ssl/cert.pem').is_file():
        cafile = '/etc/ssl/cert.pem'
    context = ssl.create_default_context(cafile=cafile)
    return urllib.request.build_opener(NoRedirect, urllib.request.HTTPSHandler(context=context))
