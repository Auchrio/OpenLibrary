#!/usr/bin/env python3
"""
Local development server for OpenLibrary.
Identical to `python3 -m http.server` but adds the CORS headers that the
browser requires when the UI and the library are served from different origins
(or when opening index.html directly from disk).

Usage:
    python3 serve.py [port]      # default port: 8080
"""
import sys
from http.server import SimpleHTTPRequestHandler, HTTPServer


class CORSRequestHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def log_message(self, fmt, *args):
        # Quieter output — only log non-200 responses to reduce noise.
        if args and str(args[1]) != "200":
            super().log_message(fmt, *args)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    server = HTTPServer(("", port), CORSRequestHandler)
    print(f"Serving on http://localhost:{port}  (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
