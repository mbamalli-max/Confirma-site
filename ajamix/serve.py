#!/usr/bin/env python3
import os, sys
from http.server import HTTPServer, SimpleHTTPRequestHandler

port = int(os.environ.get("PORT", 3002))
directory = os.path.join(os.path.dirname(os.path.abspath(__file__)), "app")

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=directory, **kwargs)

print(f"Serving {directory} on port {port}")
HTTPServer(("", port), Handler).serve_forever()
