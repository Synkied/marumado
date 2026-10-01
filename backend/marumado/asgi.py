"""
ASGI entry point: Django (a WSGI app, run in a thread pool) for HTTP, plus the live Herdr terminal WebSocket.
"""

import os

from a2wsgi import WSGIMiddleware
from django.core.wsgi import get_wsgi_application

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'marumado.settings')

django_app = WSGIMiddleware(get_wsgi_application(), workers=8)

from core import terminal  # noqa: E402  (needs Django set up)


async def application(scope, receive, send):
    if scope['type'] == 'websocket':
        return await terminal.handle(scope, receive, send)
    if scope['type'] == 'http':
        return await django_app(scope, receive, send)
